using System.Globalization;
using System.Text.Json;
using Atlas.Windows.Core;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.System;
using WinRT.Interop;

namespace Atlas.Windows;

/// <summary>
/// The Atlas window, laid out like the web app: a sidebar of places (Home, Clients, Passwords, Assets, Documents),
/// and one page at a time beside it, with breadcrumbs showing where you are. A client opens on tabs for its
/// passwords, assets, and documents; an item opens as a page of cards with a copy button beside each value. It is hidden, not closed,
/// between uses, so the hotkey brings it back instantly. Secrets are fetched only to copy or briefly show them;
/// Atlas records each one, and a copied secret is cleared from the clipboard after 30 seconds.
/// </summary>
public sealed partial class SearchWindow : Window
{
    private const int HotkeyId = 0xA71A;
    private static readonly TimeSpan ShowFor = TimeSpan.FromSeconds(30);
    private static readonly Section[] SectionList =
    [
        new("home", "Home", ""),
        new("clients", "Clients", ""),
        new("passwords", "Passwords", ""),
        new("assets", "Assets", ""),
        new("documents", "Documents", ""),
    ];

    /// <summary>
    /// One page: a sidebar place (home, clients, passwords, assets, documents), a client with one of its tabs, the
    /// results of a search, or an item. The pages you went through make the breadcrumb trail and the way back.
    /// </summary>
    private sealed record Place(string Kind, string Title, string? ClientId = null, string Tab = "overview", Row? Item = null, string? Query = null, string Editing = "password", object? Subject = null);

    private readonly App app;
    private readonly IntPtr hwnd;
    private readonly Native.SubclassProc subclass;
    private readonly ClipboardGuard clipboard;
    private readonly List<Row> recent = [];
    private readonly Dictionary<string, LayoutInfo> layouts = [];
    private readonly List<Place> trail = [];
    // What the person starred, as "kind:id", so the star on a page shows whether it is.
    private readonly HashSet<string> starred = [];
    private List<ClientChoice> clients = [];
    private IReadOnlyList<AssetSummary> assetCache = [];
    private List<Row> loaded = [];
    // The page the loaded rows belong to. Rows are only ever shown on that page.
    private Place? loadedFor;
    private Func<Row, string>? grouping;
    private bool fillingTypes;
    private bool switchingTabs;
    private CancellationTokenSource? listCancel;
    private CancellationTokenSource? detailCancel;
    private CancellationTokenSource? signInCancel;
    private DispatcherTimer? hideTimer;
    private (TextBlock Target, string Masked)? shown;
    private Row? current;
    private PasswordEntry? password;
    private bool started;
    // Whether this sign-in may change things (sign-ins from before the app could edit may only read).
    private bool canWrite;
    private bool shuttingDown;

    public SearchWindow(App app)
    {
        this.app = app;
        InitializeComponent();
        hwnd = WindowNative.GetWindowHandle(this);
        clipboard = new ClipboardGuard(new Native.Clipboard(hwnd), TimeProvider.System);
        clipboard.Cleared += (_, _) => DispatcherQueue.TryEnqueue(() => Show("Clipboard cleared.", InfoBarSeverity.Informational));
        _ = SetUpHelloAsync();

        // An update found before this window opened shows at once; one found later shows when it's found. A closed
        // window stops listening.
        void UpdateChanged() => DispatcherQueue.TryEnqueue(ShowUpdate);
        app.UpdateChanged += UpdateChanged;
        Closed += (_, _) => app.UpdateChanged -= UpdateChanged;
        CheckUpdatesItem.Text = $"Check for updates (you have {AppInfo.VersionText})";
        ShowUpdate();

        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);
        // As big as it's comfortable, but never bigger than the screen it opens on, and centred there.
        var area = Microsoft.UI.Windowing.DisplayArea.GetFromWindowId(AppWindow.Id, Microsoft.UI.Windowing.DisplayAreaFallback.Primary).WorkArea;
        var width = Math.Min(1180, area.Width - 32);
        var height = Math.Min(780, area.Height - 32);
        AppWindow.MoveAndResize(new global::Windows.Graphics.RectInt32(
            area.X + (area.Width - width) / 2, area.Y + (area.Height - height) / 2, width, height));
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "Tray.ico"));
        // Closing hides the window; the app keeps running in the tray.
        AppWindow.Closing += (_, e) =>
        {
            if (shuttingDown)
                return;
            e.Cancel = true;
            HideSecrets();
            AppWindow.Hide();
        };
        // The hotkey arrives as a window message.
        subclass = (h, msg, w, l, id, data) =>
        {
            if (msg == Native.WM_HOTKEY && (int)w == HotkeyId)
                DispatcherQueue.TryEnqueue(app.ShowSearch);
            return Native.DefSubclassProc(h, msg, w, l);
        };
        Native.SetWindowSubclass(hwnd, subclass, 1, 0);

        Sections.ItemsSource = SectionList;
        Accelerator(VirtualKey.F, VirtualKeyModifiers.Control, FocusSearch);
        Accelerator(VirtualKey.P, VirtualKeyModifiers.Control, () => _ = CopySecretAsync(SecretField.Password));
        Accelerator(VirtualKey.T, VirtualKeyModifiers.Control, () => _ = CopySecretAsync(SecretField.OneTimeCode));
        Accelerator(VirtualKey.U, VirtualKeyModifiers.Control, CopyUsername);
        Accelerator(VirtualKey.Left, VirtualKeyModifiers.Menu, Back);
        Accelerator(VirtualKey.Escape, VirtualKeyModifiers.None, () =>
        {
            if (QueryBox.Text.Length > 0)
                QueryBox.Text = "";
            else if (trail.Count > 1)
                Back();
            else
            {
                HideSecrets();
                AppWindow.Hide();
            }
        });
    }

    private void Accelerator(VirtualKey key, VirtualKeyModifiers modifiers, Action run)
    {
        var accelerator = new KeyboardAccelerator { Key = key, Modifiers = modifiers };
        accelerator.Invoked += (_, e) =>
        {
            e.Handled = true;
            run();
        };
        Root.KeyboardAccelerators.Add(accelerator);
        Root.KeyboardAcceleratorPlacementMode = KeyboardAcceleratorPlacementMode.Hidden;
    }

    public bool RegisterHotkey() => Native.RegisterSearchHotkey(hwnd, HotkeyId);

    public void ClearClipboard() => clipboard.ClearNow();

    public void Shutdown()
    {
        shuttingDown = true;
        Native.UnregisterHotKey(hwnd, HotkeyId);
        clipboard.Dispose();
        Close();
    }

    // ---------- showing ----------
    public void ShowSetup(string? address, string? message = null)
    {
        if (hello.Locked)
        {
            Bring();
            return;
        }
        MainPanel.Visibility = Visibility.Collapsed;
        SetupPanel.Visibility = Visibility.Visible;
        QueryBox.Visibility = Visibility.Collapsed;
        AccountButton.Visibility = Visibility.Collapsed;
        AppTitleBar.Subtitle = "";
        started = false;
        recent.Clear();
        layouts.Clear();
        trail.Clear();
        HideSecrets();
        AddressBox.Text = address ?? "";
        SetupMessage.IsOpen = message is not null;
        SetupMessage.Severity = InfoBarSeverity.Warning;
        SetupMessage.Message = message ?? "";
        Bring();
        AddressBox.Focus(FocusState.Programmatic);
    }

    public void ShowSearch()
    {
        // Locked: the window comes up with only the way to unlock it.
        if (hello.Locked)
        {
            Bring();
            UnlockButton.Focus(FocusState.Programmatic);
            return;
        }
        SetupPanel.Visibility = Visibility.Collapsed;
        MainPanel.Visibility = Visibility.Visible;
        QueryBox.Visibility = Visibility.Visible;
        AccountButton.Visibility = Visibility.Visible;
        Bring();
        if (!started)
        {
            started = true;
            _ = LoadAccountAsync();
            Go(new Place("home", "Home"), fresh: true);
        }
        FocusSearch();
    }

    private void FocusSearch()
    {
        QueryBox.Focus(FocusState.Programmatic);
        QueryBox.SelectAll();
    }

    private void Bring()
    {
        // Minimized stays minimized after Show, so restore it first.
        if (AppWindow.Presenter is Microsoft.UI.Windowing.OverlappedPresenter { State: Microsoft.UI.Windowing.OverlappedPresenterState.Minimized } presenter)
            presenter.Restore();
        AppWindow.Show();
        AppWindow.MoveInZOrderAtTop();
        Activate();
        Native.SetForegroundWindow(hwnd);
    }

    private async Task LoadAccountAsync()
    {
        if (app.Client is not { } client)
            return;
        AccountServer.Text = client.Address.ToString().Replace("https://", "", StringComparison.Ordinal);
        try
        {
            var session = await client.GetSessionAsync();
            AccountName.Text = session.User.Name;
            canWrite = session.CanWrite;
            screenConnect = session.ScreenConnect;
            ToolTipService.SetToolTip(AccountButton, $"{session.User.Name} · {session.User.Email}");
            AccountInitials.Text = Initials(session.User.Name);
            AppTitleBar.Subtitle = session.Organization.Name;
            foreach (var layout in await client.ListLayoutsAsync())
                layouts[layout.Id] = layout;
            try
            {
                foreach (var f in await client.ListFavoritesAsync())
                    starred.Add($"{f.Type}:{f.Id}");
                ShowStar();
            }
            catch (AtlasApiException ex) when (ex.Code == "api_scope")
            {
                // An Atlas older than this app doesn't share favorites with it yet.
            }
            var list = await client.ListClientsAsync();
            clients = [.. list.Where(c => c.Status != "inactive").Select(c => new ClientChoice(c.Id, c.Name))];
            if (trail.LastOrDefault()?.Kind == "clients")
                _ = LoadPageAsync();
        }
        catch (Exception ex) when (ex is AtlasApiException or HttpRequestException)
        {
            Fail(ex);
        }
    }

    private static string Initials(string name) =>
        string.Concat(name.Split(' ', StringSplitOptions.RemoveEmptyEntries).Take(2).Select(w => char.ToUpperInvariant(w[0])));

    // ---------- sign-in ----------
    private void AddressBox_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Enter)
            SignInButton_Click(sender, e);
    }

    private async void SignInButton_Click(object sender, RoutedEventArgs e)
    {
        if (!AtlasAddress.TryParse(AddressBox.Text, out var address, out var error))
        {
            SetupMessage.Severity = InfoBarSeverity.Error;
            SetupMessage.Message = error;
            SetupMessage.IsOpen = true;
            return;
        }
        signInCancel?.Cancel();
        signInCancel = new CancellationTokenSource();
        SignInButton.IsEnabled = false;
        SignInProgress.IsActive = true;
        SetupMessage.Severity = InfoBarSeverity.Informational;
        SetupMessage.Message = "Finish signing in in your browser.";
        SetupMessage.IsOpen = true;
        try
        {
            await app.SignInAsync(address!, signInCancel.Token);
            ShowSearch();
        }
        catch (Exception ex) when (ex is AtlasApiException or HttpRequestException or TimeoutException or TaskCanceledException)
        {
            SetupMessage.Severity = InfoBarSeverity.Error;
            SetupMessage.Message = ex is HttpRequestException unreachable ? ConnectionProblem.Describe(unreachable) : ex.Message;
            SetupMessage.IsOpen = true;
        }
        finally
        {
            SignInButton.IsEnabled = true;
            SignInProgress.IsActive = false;
        }
    }

    // ---------- going places ----------
    /// <summary>Opens a page. From the sidebar the trail starts again; anywhere else the page is added to it.</summary>
    private void Go(Place place, bool fresh = false)
    {
        if (fresh)
            trail.Clear();
        // A search refines the one before it rather than piling up.
        if (place.Kind == "search" && trail.LastOrDefault()?.Kind == "search")
            trail.RemoveAt(trail.Count - 1);
        trail.Add(place);
        ShowPlace();
    }

    private void Back()
    {
        if (trail.Count < 2)
            return;
        if (trail[^1].Kind == "search")
        {
            QueryBox.TextChanged -= QueryBox_TextChanged;
            QueryBox.Text = "";
            QueryBox.TextChanged += QueryBox_TextChanged;
        }
        trail.RemoveAt(trail.Count - 1);
        ShowPlace();
    }

    private void Back_Click(object sender, RoutedEventArgs e) => Back();

    private void Crumbs_ItemClicked(BreadcrumbBar sender, BreadcrumbBarItemClickedEventArgs e)
    {
        if (e.Index >= trail.Count - 1)
            return;
        trail.RemoveRange(e.Index + 1, trail.Count - e.Index - 1);
        ShowPlace();
    }

    private void Sections_ItemClick(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is not Section chosen)
            return;
        QueryBox.TextChanged -= QueryBox_TextChanged;
        QueryBox.Text = "";
        QueryBox.TextChanged += QueryBox_TextChanged;
        ArchivedToggle.IsChecked = false;
        Go(new Place(chosen.Id, chosen.Label), fresh: true);
    }

    private void Results_ItemClick(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is not Row row)
            return;
        if (row.Kind == "client")
            Go(new Place("client", row.Title, ClientId: row.Id));
        else
            Go(new Place("item", row.Title, Item: row));
    }

    private void Tabs_SelectionChanged(SelectorBar sender, SelectorBarSelectionChangedEventArgs e)
    {
        if (switchingTabs || sender.SelectedItem is not { Tag: string tab } || trail.LastOrDefault() is not { Kind: "client" } place)
            return;
        trail[^1] = place with { Tab = tab };
        ShowPlace();
    }

    /// <summary>Draws the page at the end of the trail: the breadcrumbs, the sidebar, and a list or an item.</summary>
    private void ShowPlace()
    {
        var place = trail[^1];
        Crumbs.ItemsSource = trail.Select(p => p.Title).ToList();
        BackButton.IsEnabled = trail.Count > 1;
        var root = SectionList.FirstOrDefault(s => s.Id == trail[0].Kind);
        Sections.SelectedItem = root;
        HideSecrets();
        StatusBar.IsOpen = false;

        var isItem = place.Kind == "item";
        var isOverview = place.Kind == "client" && place.Tab == "overview";
        var isEditor = place.Kind == "edit";
        var showsPasswords = place.Kind == "passwords" || (place.Kind == "client" && place.Tab == "passwords");
        var showsAssets = place.Kind == "assets" || (place.Kind == "client" && place.Tab == "assets");
        var showsDocuments = place.Kind == "documents" || (place.Kind == "client" && place.Tab == "documents");
        NewButton.Visibility = canWrite && (showsPasswords || showsAssets || showsDocuments) ? Visibility.Visible : Visibility.Collapsed;
        NewText.Text = showsAssets ? "New asset" : showsDocuments ? "New document" : "New password";
        // A document says whether you may change it once it's open (see ShowDocument).
        var editable = canWrite && place.Item is { Kind: "password" or "asset", Archived: false };
        EditHereButton.Visibility = editable ? Visibility.Visible : Visibility.Collapsed;
        ConnectButton.Visibility = Visibility.Collapsed;
        connectLink = null;
        ArchiveButton.Visibility = editable ? Visibility.Visible : Visibility.Collapsed;
        RestoreButton.Visibility = canWrite && place.Item is { Archived: true } ? Visibility.Visible : Visibility.Collapsed;
        var listKind = place.Kind == "client" ? place.Tab : place.Kind;
        ArchivedToggle.Visibility = listKind is "passwords" or "assets" or "documents" ? Visibility.Visible : Visibility.Collapsed;
        if (ArchivedToggle.IsChecked == true && listKind is "passwords" or "assets" or "documents")
            NewButton.Visibility = Visibility.Collapsed;
        ListPanel.Visibility = isItem || isOverview || isEditor ? Visibility.Collapsed : Visibility.Visible;
        DetailScroll.Visibility = isItem || isOverview || isEditor ? Visibility.Visible : Visibility.Collapsed;
        DetailBar.Visibility = isItem ? Visibility.Visible : Visibility.Collapsed;
        FilterBox.Visibility = isItem || isOverview || isEditor || place.Kind == "search" ? Visibility.Collapsed : Visibility.Visible;
        TypeFilter.Visibility = Visibility.Collapsed;
        Tabs.Visibility = place.Kind == "client" ? Visibility.Visible : Visibility.Collapsed;
        PageTitle.Text = place.Title;
        PageInfo.Text = "";
        ShowStar();
        if (isEditor)
        {
            PageInfo.Text = place.Item is null ? "Saved encrypted in the client's vault, and recorded under your name." : "Only what you change is saved. The old password is kept in the entry's history.";
            if (place.Editing == "document")
            {
                PageInfo.Text = place.Item is not null ? "Each save is a new version. Earlier versions stay in the document's history."
                    : place.ClientId is null ? "Without a client, it goes in the knowledge base." : "Saved with the client's documents.";
                ShowDocumentEditor(place);
            }
            else if (place.Editing is "contact" or "location")
            {
                PageInfo.Text = place.Editing == "contact" ? "Shown on the client's overview, and in Atlas." : "Shown on the client's overview, with a button to copy the address.";
                ShowPersonEditor(place);
            }
            else if (place.Editing == "asset")
            {
                PageInfo.Text = place.Item is null ? "Atlas checks each field against the asset's type when it's saved." : "Only what you change is saved. The previous version is kept in the asset's history.";
                ShowAssetEditor(place);
            }
            else
                ShowPasswordEditor(place);
            return;
        }
        if (isItem)
        {
            PageInfo.Text = Join(Kind(place.Item!.Kind), place.Item.ClientName);
            ShowItem(place.Item);
            return;
        }
        if (place.Kind == "client")
        {
            switchingTabs = true;
            Tabs.SelectedItem = place.Tab switch { "passwords" => PasswordsTab, "assets" => AssetsTab, "documents" => DocumentsTab, _ => OverviewTab };
            switchingTabs = false;
            if (isOverview)
            {
                ShowOverview(place.ClientId!);
                return;
            }
        }
        // The rows on screen belong to the page before: clear them first, so none of them show under this page's
        // title while it loads, or after if loading fails.
        loaded = [];
        loadedFor = null;
        grouping = null;
        Results.ItemsSource = null;
        ListEmpty.Visibility = Visibility.Collapsed;
        FilterBox.Text = "";
        _ = LoadPageAsync();
    }

    // ---------- adding and changing passwords ----------
    private static readonly (string Label, int? Days)[] RotationChoices =
    [
        ("Don't remind me", null),
        ("Every 30 days", 30),
        ("Every 60 days", 60),
        ("Every 90 days", 90),
        ("Every 6 months", 180),
        ("Every year", 365),
    ];

    private void New_Click(object sender, RoutedEventArgs e)
    {
        var place = trail.LastOrDefault();
        var kind = place is { Kind: "assets" } or { Kind: "client", Tab: "assets" } ? "asset"
            : place is { Kind: "documents" } or { Kind: "client", Tab: "documents" } ? "document"
            : "password";
        Go(new Place("edit", $"New {kind}", ClientId: place?.Kind == "client" ? place.ClientId : null, Editing: kind));
    }

    private void EditHere_Click(object sender, RoutedEventArgs e)
    {
        if (current is { Kind: "password" or "asset" or "document" } row)
            Go(new Place("edit", $"Edit {row.Title}", ClientId: row.ClientId, Item: row, Editing: row.Kind));
    }

    private async void Archive_Click(object sender, RoutedEventArgs e)
    {
        if (current is not { Kind: "password" or "asset" or "document" } row || app.Client is not { } client)
            return;
        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            Title = $"Archive {row.Title}?",
            Content = "It leaves the lists and search. It isn't deleted: you can restore it from the archived list in Atlas.",
            PrimaryButtonText = "Archive",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Close,
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary)
            return;
        try
        {
            if (row.Kind == "asset")
                await client.ArchiveAssetAsync(row.Id);
            else if (row.Kind == "document")
                await client.ArchiveDocumentAsync(row.Id);
            else
                await client.ArchivePasswordAsync(row.Id);
            recent.RemoveAll(r => r.Kind == row.Kind && r.Id == row.Id);
            Back();
            Show($"{row.Title} archived. Restore it from the archived list in Atlas.", InfoBarSeverity.Success);
        }
        catch (Exception ex) when (ex is AtlasApiException or HttpRequestException)
        {
            Fail(ex);
        }
    }

    /// <summary>The form for a new password, or for changing one. Secrets already saved are never shown here.</summary>
    private async void ShowPasswordEditor(Place place)
    {
        detailCancel?.Cancel();
        var cancel = detailCancel = new CancellationTokenSource();
        HideSecrets();
        password = null;
        current = null;
        ClearDetail();
        DetailScroll.ChangeView(null, 0, null, true);
        if (app.Client is not { } client)
            return;
        PasswordEntry? existing = null;
        IReadOnlyList<PasswordFolder> folders = [];
        try
        {
            if (place.Item is { } row)
                existing = await client.GetPasswordAsync(row.Id, cancel.Token);
            var clientId = existing?.ClientId ?? place.ClientId;
            if (clientId is not null)
                folders = await client.ListPasswordFoldersAsync(clientId, cancel.Token);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        catch (Exception ex) when (ex is AtlasApiException or HttpRequestException)
        {
            Fail(ex);
            return;
        }
        if (cancel.IsCancellationRequested)
            return;

        var form = new StackPanel { Spacing = 14, Margin = new Thickness(0, 8, 0, 24) };
        ComboBox? clientBox = null;
        if (existing is null && place.ClientId is null)
        {
            clientBox = new ComboBox { Header = "Client", PlaceholderText = "Choose the client it belongs to", HorizontalAlignment = HorizontalAlignment.Stretch };
            clientBox.ItemsSource = clients.Select(c => c.Name).ToList();
            form.Children.Add(clientBox);
        }
        else
        {
            var owner = existing?.ClientName ?? clients.FirstOrDefault(c => c.Id == place.ClientId)?.Name ?? "";
            form.Children.Add(new TextBlock { Text = $"Client: {owner}", Foreground = Secondary() });
        }
        var name = new TextBox { Header = "Name", Text = existing?.Name ?? "", PlaceholderText = "For example, HDG-FW-01 admin", MaxLength = 200 };
        var username = new TextBox { Header = "Username", Text = existing?.Username ?? "", MaxLength = 254 };
        var secret = new PasswordBox
        {
            Header = existing is null ? "Password" : "New password",
            PlaceholderText = existing is null ? "" : "Leave empty to keep the current password",
            PasswordRevealMode = PasswordRevealMode.Peek,
            HorizontalAlignment = HorizontalAlignment.Stretch,
        };
        var generate = new Button { Content = "Generate", VerticalAlignment = VerticalAlignment.Bottom };
        generate.Click += (_, _) =>
        {
            secret.Password = PasswordGenerator.Generate();
            secret.PasswordRevealMode = PasswordRevealMode.Visible;
        };
        var secretRow = new Grid { ColumnSpacing = 8 };
        secretRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        secretRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(generate, 1);
        secretRow.Children.Add(secret);
        secretRow.Children.Add(generate);
        var url = new TextBox { Header = "Website or address", Text = existing?.Url ?? "", PlaceholderText = "https://", InputScope = new InputScope { Names = { new InputScopeName(InputScopeNameValue.Url) } } };
        var totp = new PasswordBox
        {
            Header = "Authenticator setup key (optional)",
            PlaceholderText = existing?.HasTotp == true ? "Leave empty to keep the current key" : "The key shown when two-step sign-in was set up",
            PasswordRevealMode = PasswordRevealMode.Peek,
        };
        var removeTotp = new CheckBox { Content = "Remove the one-time code", Visibility = existing?.HasTotp == true ? Visibility.Visible : Visibility.Collapsed };
        var folder = new ComboBox { Header = "Folder", HorizontalAlignment = HorizontalAlignment.Stretch };
        var folderChoices = new List<(string? Id, string Name)> { (null, "No folder") };
        folderChoices.AddRange(folders.Select(f => ((string?)f.Id, f.Name)));
        folder.ItemsSource = folderChoices.Select(f => f.Name).ToList();
        folder.SelectedIndex = Math.Max(0, folderChoices.FindIndex(f => f.Id == existing?.FolderId));
        folder.Visibility = folders.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        var rotation = new ComboBox { Header = "Remind me to change it", HorizontalAlignment = HorizontalAlignment.Stretch };
        rotation.ItemsSource = RotationChoices.Select(c => c.Label).ToList();
        rotation.SelectedIndex = Math.Max(0, Array.FindIndex(RotationChoices, c => c.Days == existing?.RotationDays));
        var notes = new TextBox
        {
            Header = "Notes",
            AcceptsReturn = true,
            TextWrapping = TextWrapping.Wrap,
            MinHeight = 80,
            MaxLength = 20000,
            PlaceholderText = existing?.HasNotes == true ? "Leave empty to keep the current notes" : "Kept encrypted, like the password",
        };
        var error = new InfoBar { Severity = InfoBarSeverity.Error, IsClosable = false };
        var save = new Button { Content = existing is null ? "Add password" : "Save changes", Style = (Style)Application.Current.Resources["AccentButtonStyle"] };
        AutomationProperties.SetAutomationId(save, "SaveButton");
        var cancelButton = new Button { Content = "Cancel" };
        cancelButton.Click += (_, _) => Back();
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 6, 0, 0) };
        buttons.Children.Add(save);
        buttons.Children.Add(cancelButton);
        foreach (var control in new UIElement[] { name, username, secretRow, url, totp, removeTotp, folder, rotation, notes, error, buttons })
            form.Children.Add(control);
        PairShortFields(form);
        Detail.Children.Add(form);
        name.Focus(FocusState.Programmatic);

        save.Click += async (_, _) =>
        {
            error.IsOpen = false;
            var clientId = existing?.ClientId ?? place.ClientId ?? (clientBox?.SelectedIndex is >= 0 and var i ? clients[i].Id : null);
            string? problem = clientId is null ? "Choose the client it belongs to."
                : name.Text.Trim().Length == 0 ? "Give it a name."
                : existing is null && secret.Password.Length == 0 ? "Enter the password, or choose Generate."
                : url.Text.Trim().Length > 0 && !IsWebAddress(url.Text.Trim()) ? "The address must start with http:// or https://."
                : null;
            if (problem is not null)
            {
                error.Message = problem;
                error.IsOpen = true;
                return;
            }
            var draft = new PasswordDraft(
                name.Text.Trim(),
                username.Text.Trim(),
                url.Text.Trim(),
                secret.Password.Length > 0 ? secret.Password : null,
                removeTotp.IsChecked == true ? "" : totp.Password.Length > 0 ? totp.Password.Replace(" ", "", StringComparison.Ordinal) : null,
                notes.Text.Length > 0 ? notes.Text : null,
                RotationChoices[Math.Max(0, rotation.SelectedIndex)].Days,
                folderChoices[Math.Max(0, folder.SelectedIndex)].Id);
            save.IsEnabled = false;
            try
            {
                var saved = existing is null
                    ? await client.CreatePasswordAsync(clientId!, draft)
                    : await client.UpdatePasswordAsync(existing.Id, existing.Version, draft);
                var row = new Row("password", saved.Id, saved.Name, saved.Username, saved.ClientId, saved.ClientName);
                Remember(row);
                // The form gives way to the saved entry, so Back goes where it would have before.
                trail[^1] = new Place("item", row.Title, Item: row);
                if (existing is not null && trail.Count > 1 && trail[^2] is { Kind: "item", Item: { } before } && before.Id == row.Id)
                    trail.RemoveAt(trail.Count - 2);
                ShowPlace();
                Show(
                    existing is null ? $"{row.Title} added."
                    : draft.Secret is not null ? "Saved. The previous password is in the entry's history."
                    : "Changes saved.",
                    InfoBarSeverity.Success);
            }
            catch (AtlasApiException ex) when (ex.Status == System.Net.HttpStatusCode.Conflict)
            {
                error.Message = "Someone saved this password while you were editing. Copy anything you typed, then go back and open it again.";
                error.IsOpen = true;
                save.IsEnabled = true;
            }
            catch (AtlasApiException ex)
            {
                error.Message = ex.Message;
                error.IsOpen = true;
                save.IsEnabled = true;
            }
            catch (HttpRequestException ex)
            {
                error.Message = ConnectionProblem.Describe(ex);
                error.IsOpen = true;
                save.IsEnabled = true;
            }
        };
    }

    // ---------- adding and changing assets ----------
    private static readonly (string Value, string Label)[] AssetStatuses = [("active", "Active"), ("inactive", "Inactive"), ("retired", "Retired")];

    /// <summary>
    /// The form for a new asset, or for changing one, built from the asset's layout: a box for text, a list for a
    /// choice, ticks for several, a date picker for dates. Atlas checks every field again when it's saved.
    /// </summary>
    private async void ShowAssetEditor(Place place)
    {
        detailCancel?.Cancel();
        var cancel = detailCancel = new CancellationTokenSource();
        HideSecrets();
        password = null;
        current = null;
        ClearDetail();
        DetailScroll.ChangeView(null, 0, null, true);
        if (app.Client is not { } client)
            return;
        AssetSummary? existing = null;
        try
        {
            if (place.Item is { } row)
                existing = await client.GetAssetAsync(row.Id, cancel.Token);
            if (layouts.Count == 0)
                foreach (var layout in await client.ListLayoutsAsync(cancel.Token))
                    layouts[layout.Id] = layout;
        }
        catch (OperationCanceledException)
        {
            return;
        }
        catch (Exception ex) when (ex is AtlasApiException or HttpRequestException)
        {
            Fail(ex);
            return;
        }
        if (cancel.IsCancellationRequested)
            return;
        if (existing is not null && existing.Notes.Contains("Synced from", StringComparison.OrdinalIgnoreCase))
            PageInfo.Text = "This asset is kept up to date by a sync: fields it fills are replaced at the next sync. Fields you add yourself are kept.";

        var form = new StackPanel { Spacing = 14, Margin = new Thickness(0, 8, 0, 24) };
        ComboBox? clientBox = null;
        if (existing is null && place.ClientId is null)
        {
            clientBox = new ComboBox { Header = "Client", PlaceholderText = "Choose the client it belongs to", HorizontalAlignment = HorizontalAlignment.Stretch };
            clientBox.ItemsSource = clients.Select(c => c.Name).ToList();
            form.Children.Add(clientBox);
        }
        else
        {
            var owner = existing?.ClientName ?? clients.FirstOrDefault(c => c.Id == place.ClientId)?.Name ?? "";
            form.Children.Add(new TextBlock { Text = $"Client: {owner}", Foreground = Secondary() });
        }

        // The layout can only be chosen for a new asset; its fields are drawn below and redrawn when it changes.
        var layoutList = layouts.Values.OrderBy(l => l.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
        var layoutBox = new ComboBox { Header = "Asset layout", HorizontalAlignment = HorizontalAlignment.Stretch, ItemsSource = layoutList.Select(l => l.Name).ToList() };
        if (existing is not null)
        {
            layoutBox.SelectedIndex = layoutList.FindIndex(l => l.Id == existing.LayoutId);
            layoutBox.IsEnabled = false;
        }
        var name = new TextBox { Header = "Name", Text = existing?.Name ?? "", MaxLength = 200, PlaceholderText = "For example, HDG-FW-01" };
        var status = new ComboBox { Header = "Status", HorizontalAlignment = HorizontalAlignment.Stretch, ItemsSource = AssetStatuses.Select(s => s.Label).ToList() };
        status.SelectedIndex = Math.Max(0, Array.FindIndex(AssetStatuses, s => s.Value == (existing?.Status ?? "active")));
        var fieldsPanel = new StackPanel { Spacing = 14 };
        var readers = new List<(LayoutField Field, Func<object?> Read)>();
        void DrawFields()
        {
            fieldsPanel.Children.Clear();
            readers.Clear();
            if (layoutBox.SelectedIndex < 0)
                return;
            foreach (var field in layoutList[layoutBox.SelectedIndex].Fields)
            {
                JsonElement? value = existing is not null && existing.Fields.TryGetValue(field.Key, out var v) ? v : null;
                var (control, read) = FieldEditor(field, value);
                fieldsPanel.Children.Add(control);
                readers.Add((field, read));
            }
            PairShortFields(fieldsPanel);
        }
        layoutBox.SelectionChanged += (_, _) => DrawFields();
        var notes = new TextBox { Header = "Notes", Text = existing?.Notes ?? "", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 80, MaxLength = 20000 };
        var error = new InfoBar { Severity = InfoBarSeverity.Error, IsClosable = false };
        var save = new Button { Content = existing is null ? "Add asset" : "Save changes", Style = (Style)Application.Current.Resources["AccentButtonStyle"] };
        AutomationProperties.SetAutomationId(save, "SaveButton");
        var cancelButton = new Button { Content = "Cancel" };
        cancelButton.Click += (_, _) => Back();
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 6, 0, 0) };
        buttons.Children.Add(save);
        buttons.Children.Add(cancelButton);
        foreach (var control in new UIElement[] { layoutBox, name, status, fieldsPanel, notes, error, buttons })
            form.Children.Add(control);
        PairShortFields(form);
        Detail.Children.Add(form);
        DrawFields();
        (existing is null ? (Control)layoutBox : name).Focus(FocusState.Programmatic);

        save.Click += async (_, _) =>
        {
            error.IsOpen = false;
            var clientId = existing?.ClientId ?? place.ClientId ?? (clientBox?.SelectedIndex is >= 0 and var i ? clients[i].Id : null);
            var missing = readers.FirstOrDefault(r => r.Field.Required && IsEmpty(r.Read()));
            string? problem = clientId is null ? "Choose the client it belongs to."
                : layoutBox.SelectedIndex < 0 ? "Choose the asset layout."
                : name.Text.Trim().Length == 0 ? "Give it a name."
                : missing.Field is not null ? $"{missing.Field.Label} is required."
                : null;
            if (problem is not null)
            {
                error.Message = problem;
                error.IsOpen = true;
                return;
            }
            var values = readers.ToDictionary(r => r.Field.Key, r => r.Read());
            var statusValue = AssetStatuses[Math.Max(0, status.SelectedIndex)].Value;
            save.IsEnabled = false;
            try
            {
                var saved = existing is null
                    ? await client.CreateAssetAsync(clientId!, layoutList[layoutBox.SelectedIndex].Id, name.Text.Trim(), statusValue, values, notes.Text)
                    : await client.UpdateAssetAsync(existing.Id, existing.Version, name.Text.Trim(), statusValue, values, notes.Text);
                var row = new Row("asset", saved.Id, saved.Name, saved.LayoutName, saved.ClientId, saved.ClientName);
                Remember(row);
                trail[^1] = new Place("item", row.Title, Item: row);
                if (existing is not null && trail.Count > 1 && trail[^2] is { Kind: "item", Item: { } before } && before.Id == row.Id)
                    trail.RemoveAt(trail.Count - 2);
                ShowPlace();
                Show(existing is null ? $"{row.Title} added." : "Changes saved. The previous version is in the asset's history.", InfoBarSeverity.Success);
            }
            catch (AtlasApiException ex) when (ex.Status == System.Net.HttpStatusCode.Conflict)
            {
                error.Message = "Someone saved this asset while you were editing. Copy anything you typed, then go back and open it again.";
                error.IsOpen = true;
                save.IsEnabled = true;
            }
            catch (AtlasApiException ex)
            {
                error.Message = ex.Message;
                error.IsOpen = true;
                save.IsEnabled = true;
            }
            catch (HttpRequestException ex)
            {
                error.Message = ConnectionProblem.Describe(ex);
                error.IsOpen = true;
                save.IsEnabled = true;
            }
        };
    }

    private static bool IsEmpty(object? value) =>
        value is null || (value is string s && s.Trim().Length == 0) || (value is IList<string> list && list.Count == 0) || value is false;

    /// <summary>The control for one layout field, and how to read what was entered (null for nothing).</summary>
    private static (UIElement Control, Func<object?> Read) FieldEditor(LayoutField field, JsonElement? value)
    {
        var label = Tidy(field.Label) + (field.Required ? " *" : "");
        var text = value is { } v ? Display(v) : "";
        switch (field.Type)
        {
            case "select":
            {
                var choices = new List<string> { "" };
                choices.AddRange(field.Options ?? []);
                // A value from before the list changed is kept rather than lost.
                if (text.Length > 0 && !choices.Contains(text))
                    choices.Add(text);
                var box = new ComboBox { Header = label, ItemsSource = choices, SelectedItem = text, HorizontalAlignment = HorizontalAlignment.Stretch };
                return (box, () => box.SelectedItem is string s && s.Length > 0 ? s : null);
            }
            case "multiselect":
            {
                var chosen = value is { ValueKind: JsonValueKind.Array } array ? array.EnumerateArray().Select(Display).ToHashSet() : [];
                var panel = new StackPanel { Spacing = 2 };
                panel.Children.Add(new TextBlock { Text = label });
                var boxes = (field.Options ?? []).Select(o => new CheckBox { Content = o, IsChecked = chosen.Contains(o) }).ToList();
                foreach (var box in boxes)
                    panel.Children.Add(box);
                return (panel, () => boxes.Where(b => b.IsChecked == true).Select(b => (string)b.Content).ToList());
            }
            case "checkbox":
            {
                var box = new CheckBox { Content = label, IsChecked = value is { ValueKind: JsonValueKind.True } };
                return (box, () => box.IsChecked == true);
            }
            case "date":
            {
                var picker = new CalendarDatePicker { Header = label, PlaceholderText = "Choose a date", HorizontalAlignment = HorizontalAlignment.Stretch };
                if (DateTimeOffset.TryParse(text, out var day))
                    picker.Date = day;
                return (picker, () => picker.Date?.ToString("yyyy-MM-dd"));
            }
            case "number":
            {
                var box = new NumberBox { Header = label, Value = double.TryParse(text, out var n) ? n : double.NaN, SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Hidden };
                return (box, () => double.IsNaN(box.Value) ? null : box.Value);
            }
            case "textarea":
            {
                var box = new TextBox { Header = label, Text = text, AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 70, MaxLength = 10000 };
                return (box, () => box.Text.Length > 0 ? box.Text : null);
            }
            default:
            {
                var box = new TextBox { Header = label, Text = text, MaxLength = field.Type == "phone" ? 40 : 500, PlaceholderText = field.Help ?? "" };
                if (field.Type is "ip" or "url")
                {
                    // The code font is for what's typed; the label keeps the normal one.
                    box.FontFamily = new FontFamily("Cascadia Mono, Consolas");
                    box.Header = new TextBlock { Text = label, FontFamily = FontFamily.XamlAutoFontFamily };
                    AutomationProperties.SetName(box, label);
                }
                return (box, () => box.Text.Trim().Length > 0 ? box.Text.Trim() : null);
            }
        }
    }

    // ---------- adding and changing contacts and locations ----------
    private UIElement AddRow(string text, string editing, string clientId)
    {
        var button = new Button { Content = text, Margin = new Thickness(12, 8, 12, 10) };
        button.Click += (_, _) => Go(new Place("edit", text, ClientId: clientId, Editing: editing));
        return button;
    }

    private Button[] PersonActions(string editing, string id, string name, object subject, string clientId) =>
    [
        IconButton("", $"Edit {name}", (_, _) => Go(new Place("edit", $"Edit {name}", ClientId: clientId, Editing: editing, Subject: subject))),
        IconButton("", $"Delete {name}", (_, _) => DeletePerson(editing, id, name)),
    ];

    private async void DeletePerson(string editing, string id, string name)
    {
        if (app.Client is not { } client)
            return;
        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            Title = $"Delete {name}?",
            Content = editing == "contact" ? "The contact is removed from this client." : "The location is removed from this client.",
            PrimaryButtonText = "Delete",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Close,
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary)
            return;
        try
        {
            if (editing == "contact")
                await client.DeleteContactAsync(id);
            else
                await client.DeleteLocationAsync(id);
            ShowPlace();
            Show($"{name} deleted.", InfoBarSeverity.Success);
        }
        catch (Exception ex) when (ex is AtlasApiException or HttpRequestException)
        {
            Fail(ex);
        }
    }

    /// <summary>The form for a contact or a location. Saving goes back to the client's overview.</summary>
    private void ShowPersonEditor(Place place)
    {
        detailCancel?.Cancel();
        HideSecrets();
        password = null;
        current = null;
        ClearDetail();
        DetailScroll.ChangeView(null, 0, null, true);
        var isContact = place.Editing == "contact";
        var contact = place.Subject as ContactInfo;
        var location = place.Subject as LocationInfo;
        var adding = place.Subject is null;

        var form = new StackPanel { Spacing = 14, Margin = new Thickness(0, 8, 0, 24) };
        var owner = clients.FirstOrDefault(c => c.Id == place.ClientId)?.Name ?? "";
        form.Children.Add(new TextBlock { Text = $"Client: {owner}", Foreground = Secondary() });
        TextBox Box(string header, string text, int max, string hint = "")
        {
            var box = new TextBox { Header = header, Text = text, MaxLength = max, PlaceholderText = hint };
            AutomationProperties.SetName(box, header);
            form.Children.Add(box);
            return box;
        }
        var name = Box("Name", contact?.Name ?? location?.Name ?? "", 120, isContact ? "For example, Dana Morales" : "For example, Main office");
        TextBox title = null!, email = null!, phone, mobile = null!, address = null!, city = null!, region = null!, postal = null!, country = null!;
        if (isContact)
        {
            title = Box("Title", contact?.Title ?? "", 120, "For example, Office manager");
            email = Box("Email", contact?.Email ?? "", 254);
            email.InputScope = new InputScope { Names = { new InputScopeName(InputScopeNameValue.EmailSmtpAddress) } };
            phone = Box("Phone", contact?.Phone ?? "", 40);
            mobile = Box("Mobile", contact?.Mobile ?? "", 40);
        }
        else
        {
            address = Box("Address", location?.Address ?? "", 200);
            var cityRow = new Grid { ColumnSpacing = 8 };
            cityRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(2, GridUnitType.Star) });
            cityRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            cityRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            city = new TextBox { Header = "City", Text = location?.City ?? "", MaxLength = 120 };
            region = new TextBox { Header = "State or region", Text = location?.Region ?? "", MaxLength = 120 };
            postal = new TextBox { Header = "Postal code", Text = location?.PostalCode ?? "", MaxLength = 20 };
            AutomationProperties.SetName(city, "City");
            AutomationProperties.SetName(region, "State or region");
            AutomationProperties.SetName(postal, "Postal code");
            Grid.SetColumn(region, 1);
            Grid.SetColumn(postal, 2);
            cityRow.Children.Add(city);
            cityRow.Children.Add(region);
            cityRow.Children.Add(postal);
            form.Children.Add(cityRow);
            country = Box("Country", location?.Country ?? "", 80);
            phone = Box("Phone", location?.Phone ?? "", 40);
        }
        var notes = new TextBox { Header = "Notes", Text = contact?.Notes ?? location?.Notes ?? "", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 80, MaxLength = 5000 };
        var primary = new CheckBox
        {
            Content = isContact ? "Primary contact for this client" : "Primary location for this client",
            IsChecked = contact?.Primary ?? location?.Primary ?? false,
        };
        var error = new InfoBar { Severity = InfoBarSeverity.Error, IsClosable = false };
        var save = new Button
        {
            Content = adding ? (isContact ? "Add contact" : "Add location") : "Save changes",
            Style = (Style)Application.Current.Resources["AccentButtonStyle"],
        };
        AutomationProperties.SetAutomationId(save, "SaveButton");
        var cancelButton = new Button { Content = "Cancel" };
        cancelButton.Click += (_, _) => Back();
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 6, 0, 0) };
        buttons.Children.Add(save);
        buttons.Children.Add(cancelButton);
        foreach (var control in new UIElement[] { notes, primary, error, buttons })
            form.Children.Add(control);
        PairShortFields(form);
        Detail.Children.Add(form);
        name.Focus(FocusState.Programmatic);

        save.Click += async (_, _) =>
        {
            error.IsOpen = false;
            if (app.Client is not { } client || place.ClientId is not { } clientId)
                return;
            if (name.Text.Trim().Length == 0)
            {
                error.Message = "Give it a name.";
                error.IsOpen = true;
                return;
            }
            if (isContact && email.Text.Trim() is { Length: > 0 } typed && !typed.Contains('@', StringComparison.Ordinal))
            {
                error.Message = "That email address doesn't look right.";
                error.IsOpen = true;
                return;
            }
            save.IsEnabled = false;
            try
            {
                var isPrimary = primary.IsChecked == true;
                if (isContact)
                {
                    var draft = new ContactDraft(name.Text.Trim(), title.Text.Trim(), email.Text.Trim(), phone.Text.Trim(), mobile.Text.Trim(), notes.Text.Trim(), isPrimary);
                    _ = contact is null ? await client.CreateContactAsync(clientId, draft) : await client.UpdateContactAsync(contact.Id, draft);
                }
                else
                {
                    var draft = new LocationDraft(
                        name.Text.Trim(), address.Text.Trim(), city.Text.Trim(), region.Text.Trim(), postal.Text.Trim(), country.Text.Trim(), phone.Text.Trim(), notes.Text.Trim(), isPrimary);
                    _ = location is null ? await client.CreateLocationAsync(clientId, draft) : await client.UpdateLocationAsync(location.Id, draft);
                }
                Back();
                Show(adding ? $"{name.Text.Trim()} added." : "Changes saved.", InfoBarSeverity.Success);
            }
            catch (AtlasApiException ex)
            {
                error.Message = ex.Message;
                error.IsOpen = true;
                save.IsEnabled = true;
            }
            catch (HttpRequestException ex)
            {
                error.Message = ConnectionProblem.Describe(ex);
                error.IsOpen = true;
                save.IsEnabled = true;
            }
        };
    }

    // ---------- adding and changing documents ----------
    private static readonly (string Value, string Label)[] DocumentStatuses = [("current", "Current"), ("needs_review", "Needs review"), ("draft", "Draft")];

    /// <summary>
    /// The form for a new document, or for changing one. The body is edited as text with formatting typed in
    /// (see <see cref="DocumentText"/>); a document with content the text can't hold keeps its body and only the
    /// title and status can change here.
    /// </summary>
    private async void ShowDocumentEditor(Place place)
    {
        detailCancel?.Cancel();
        var cancel = detailCancel = new CancellationTokenSource();
        HideSecrets();
        password = null;
        current = null;
        ClearDetail();
        DetailScroll.ChangeView(null, 0, null, true);
        if (app.Client is not { } client)
            return;
        DocumentDetail? existing = null;
        try
        {
            if (place.Item is { } row)
                existing = await client.GetDocumentAsync(row.Id, cancel.Token);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        catch (Exception ex) when (ex is AtlasApiException or HttpRequestException)
        {
            Fail(ex);
            return;
        }
        if (cancel.IsCancellationRequested)
            return;
        var bodyText = "";
        var bodyEditable = existing is null || DocumentText.TryEditable(existing.Content, out bodyText);

        var form = new StackPanel { Spacing = 14, MaxWidth = 760, HorizontalAlignment = HorizontalAlignment.Stretch, Margin = new Thickness(0, 8, 0, 24) };
        ComboBox? clientBox = null;
        if (existing is null && place.ClientId is null)
        {
            clientBox = new ComboBox { Header = "Where", HorizontalAlignment = HorizontalAlignment.Stretch };
            clientBox.ItemsSource = new[] { "Knowledge base (no client)" }.Concat(clients.Select(c => c.Name)).ToList();
            clientBox.SelectedIndex = 0;
            form.Children.Add(clientBox);
        }
        else
        {
            var owner = existing is not null ? existing.ClientName ?? "Knowledge base" : clients.FirstOrDefault(c => c.Id == place.ClientId)?.Name ?? "";
            form.Children.Add(new TextBlock { Text = $"Where: {owner}", Foreground = Secondary() });
        }
        var title = new TextBox { Header = "Title", Text = existing?.Title ?? "", MaxLength = 200, PlaceholderText = "For example, Firewall reboot procedure" };
        var status = new ComboBox { Header = "Status", HorizontalAlignment = HorizontalAlignment.Left, MinWidth = 220, ItemsSource = DocumentStatuses.Select(s => s.Label).ToList() };
        status.SelectedIndex = Math.Max(0, Array.FindIndex(DocumentStatuses, s => s.Value == (existing?.Status ?? "current")));
        form.Children.Add(title);
        form.Children.Add(status);

        var body = new TextBox
        {
            AcceptsReturn = true,
            TextWrapping = TextWrapping.Wrap,
            MinHeight = 360,
            IsSpellCheckEnabled = true,
            PlaceholderText = "Start writing. A blank line starts a new paragraph.",
        };
        AutomationProperties.SetName(body, "Document text");
        body.KeyboardAcceleratorPlacementMode = KeyboardAcceleratorPlacementMode.Hidden;
        if (bodyEditable)
            body.Text = bodyText;
        else
        {
            // Shown so the person can read it while changing the title or status; the stored body isn't touched.
            body.Text = RichTextPlain.From(existing!.Content);
            body.IsReadOnly = true;
            form.Children.Add(new InfoBar
            {
                Severity = InfoBarSeverity.Informational,
                IsOpen = true,
                IsClosable = false,
                Title = "The text of this document can only be changed in Atlas",
                Message = "It has tables or layout the app can't edit without losing them. You can still change its title and status here.",
            });
        }

        if (bodyEditable)
        {
            var tools = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 2 };
            // Icons where Windows has one; a letter where it doesn't.
            void Tool(object face, string tip, Action act)
            {
                var button = IconButton("", tip, (_, _) =>
                {
                    act();
                    body.Focus(FocusState.Programmatic);
                });
                button.Content = face is string glyph ? new FontIcon { Glyph = glyph, FontSize = 14 } : face;
                tools.Children.Add(button);
            }
            static TextBlock Letter(string text, global::Windows.UI.Text.TextDecorations decorations = global::Windows.UI.Text.TextDecorations.None) =>
                new() { Text = text, FontSize = 14, FontWeight = FontWeights.SemiBold, TextDecorations = decorations, HorizontalAlignment = HorizontalAlignment.Center };
            Tool("", "Bold (Ctrl+B)", () => Wrap(body, "**", "**"));
            Tool("", "Italic (Ctrl+I)", () => Wrap(body, "*", "*"));
            Tool(Letter("S", global::Windows.UI.Text.TextDecorations.Strikethrough), "Strikethrough", () => Wrap(body, "~~", "~~"));
            Tool("", "Highlight", () => Wrap(body, "==", "=="));
            tools.Children.Add(new AppBarSeparator());
            Tool(Letter("H"), "Heading", () => PrefixLines(body, _ => "## "));
            Tool("", "Bulleted list", () => PrefixLines(body, _ => "- "));
            Tool(Letter("1."), "Numbered list", () => PrefixLines(body, n => $"{n}. "));
            Tool("", "Checklist", () => PrefixLines(body, _ => "- [ ] "));
            Tool(Letter("“"), "Quote", () => PrefixLines(body, _ => "> "));
            tools.Children.Add(new AppBarSeparator());
            Tool("", "Link", () => Wrap(body, "[", "](https://)"));
            Tool("", "Code", () => Wrap(body, "`", "`"));
            AddShortcut(body, VirtualKey.B, () => Wrap(body, "**", "**"));
            AddShortcut(body, VirtualKey.I, () => Wrap(body, "*", "*"));
            form.Children.Add(tools);
        }
        form.Children.Add(body);
        if (bodyEditable)
            form.Children.Add(new TextBlock
            {
                Text = "Formatting: **bold**, *italic*, ~~struck~~, ==highlight==, `code`, [text](https://link). Start a line with # for a heading, - for a list, 1. for numbers, - [ ] for a checklist, or > for a quote. Indent two spaces to put a line under a list item.",
                TextWrapping = TextWrapping.Wrap,
                FontSize = 12,
                Foreground = Secondary(),
            });

        var preview = new StackPanel();
        var previewButton = new Microsoft.UI.Xaml.Controls.Primitives.ToggleButton { Content = "Preview" };
        previewButton.Click += (_, _) =>
        {
            preview.Children.Clear();
            if (previewButton.IsChecked != true)
                return;
            preview.Children.Add(Card("Preview", DocumentBody(JsonSerializer.SerializeToElement(DocumentText.FromText(body.Text)), "Nothing written yet.")));
        };
        var error = new InfoBar { Severity = InfoBarSeverity.Error, IsClosable = false };
        var save = new Button { Content = existing is null ? "Add document" : "Save changes", Style = (Style)Application.Current.Resources["AccentButtonStyle"] };
        AutomationProperties.SetAutomationId(save, "SaveButton");
        var cancelButton = new Button { Content = "Cancel" };
        cancelButton.Click += (_, _) => Back();
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 6, 0, 0) };
        buttons.Children.Add(save);
        buttons.Children.Add(cancelButton);
        if (bodyEditable)
            buttons.Children.Add(previewButton);
        foreach (var control in new UIElement[] { preview, error, buttons })
            form.Children.Add(control);
        Detail.Children.Add(form);
        (existing is null ? title : bodyEditable ? body : title).Focus(FocusState.Programmatic);

        save.Click += async (_, _) =>
        {
            error.IsOpen = false;
            if (title.Text.Trim().Length == 0)
            {
                error.Message = "Give it a title.";
                error.IsOpen = true;
                return;
            }
            var statusValue = DocumentStatuses[Math.Max(0, status.SelectedIndex)].Value;
            var content = bodyEditable ? DocumentText.FromText(body.Text) : null;
            save.IsEnabled = false;
            try
            {
                DocumentDetail saved;
                if (existing is null)
                {
                    var clientId = place.ClientId ?? (clientBox?.SelectedIndex is > 0 and var i ? clients[i - 1].Id : null);
                    saved = await client.CreateDocumentAsync(clientId, title.Text.Trim(), statusValue, content!);
                }
                else
                    saved = await client.UpdateDocumentAsync(existing.Id, existing.Version, title.Text.Trim(), statusValue, content);
                var row = new Row("document", saved.Id, saved.Title, saved.ClientName is null ? "Knowledge base" : "Document", saved.ClientId, saved.ClientName ?? "Knowledge base");
                Remember(row);
                trail[^1] = new Place("item", row.Title, Item: row);
                if (existing is not null && trail.Count > 1 && trail[^2] is { Kind: "item", Item: { } before } && before.Id == row.Id)
                    trail.RemoveAt(trail.Count - 2);
                ShowPlace();
                Show(existing is null ? $"{row.Title} added." : "Changes saved. The previous version is in the document's history.", InfoBarSeverity.Success);
            }
            catch (AtlasApiException ex) when (ex.Status == System.Net.HttpStatusCode.Conflict)
            {
                error.Message = "Someone saved this document while you were editing. Copy your text, then go back and open it again.";
                error.IsOpen = true;
                save.IsEnabled = true;
            }
            catch (AtlasApiException ex)
            {
                error.Message = ex.Message;
                error.IsOpen = true;
                save.IsEnabled = true;
            }
            catch (HttpRequestException ex)
            {
                error.Message = ConnectionProblem.Describe(ex);
                error.IsOpen = true;
                save.IsEnabled = true;
            }
        };
    }

    private static void AddShortcut(UIElement target, VirtualKey key, Action act)
    {
        var accelerator = new KeyboardAccelerator { Key = key, Modifiers = VirtualKeyModifiers.Control };
        accelerator.Invoked += (_, args) =>
        {
            act();
            args.Handled = true;
        };
        target.KeyboardAccelerators.Add(accelerator);
    }

    // Puts formatting around the selection, keeping the selection on the same words.
    private static void Wrap(TextBox box, string before, string after)
    {
        var start = box.SelectionStart;
        var length = box.SelectionLength;
        var text = box.Text;
        box.Text = text[..start] + before + text.Substring(start, length) + after + text[(start + length)..];
        box.Select(start + before.Length, length);
    }

    // Starts each selected line (or the line the cursor is on) with a marker, numbering from 1 where asked.
    private static void PrefixLines(TextBox box, Func<int, string> marker)
    {
        // TextBox keeps lines apart with \r.
        var text = box.Text.Replace("\r\n", "\r", StringComparison.Ordinal).Replace('\n', '\r');
        var start = Math.Min(box.SelectionStart, text.Length);
        var end = Math.Min(start + box.SelectionLength, text.Length);
        var lineStart = start == 0 ? 0 : text.LastIndexOf('\r', start - 1) + 1;
        var lineEnd = text.IndexOf('\r', end);
        if (lineEnd < 0)
            lineEnd = text.Length;
        var lines = text[lineStart..lineEnd].Split('\r');
        var changed = string.Join('\r', lines.Select((l, n) => marker(n + 1) + l));
        box.Text = text[..lineStart] + changed + text[lineEnd..];
        box.Select(lineStart + changed.Length, 0);
    }

    // ---------- a client's overview ----------
    /// <summary>The client at a glance: its quick note, hours, the people and places to know, editable where allowed.</summary>
    private async void ShowOverview(string clientId)
    {
        detailCancel?.Cancel();
        var cancel = detailCancel = new CancellationTokenSource();
        HideSecrets();
        password = null;
        current = null;
        ClearDetail();
        DetailScroll.ChangeView(null, 0, null, true);
        if (app.Client is not { } client)
            return;
        try
        {
            var detailTask = client.GetClientAsync(clientId, cancel.Token);
            var contactsTask = client.ListContactsAsync(clientId, cancel.Token);
            var locationsTask = client.ListLocationsAsync(clientId, cancel.Token);
            await Task.WhenAll(detailTask, contactsTask, locationsTask);
            if (cancel.IsCancellationRequested)
                return;
            var detail = detailTask.Result;
            var contacts = contactsTask.Result.OrderByDescending(c => c.Primary).ThenBy(c => c.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
            var locations = locationsTask.Result.OrderByDescending(l => l.Primary).ThenBy(l => l.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
            PageInfo.Text = Join(detail.Type, Access(detail.Access));

            if (!canWrite && detail.CanEdit)
                Detail.Children.Add(SignInAgainNotice());
            Detail.Children.Add(QuickNoteCard(detail));

            var facts = new List<(string Label, string Value)>();
            if ((contacts.FirstOrDefault(c => c.Primary) ?? contacts.FirstOrDefault()) is { } person)
                facts.Add(("Primary contact", Join(person.Name, person.Phone.Length > 0 ? person.Phone : person.Mobile)));
            if ((locations.FirstOrDefault(l => l.Primary) ?? locations.FirstOrDefault()) is { } place)
                facts.Add((place.Name, place.OneLine));
            if (detail.Hours.Length > 0)
                facts.Add(("Hours", detail.Hours));
            if (detail.MaintenanceWindow.Length > 0)
                facts.Add(("Maintenance window", detail.MaintenanceWindow));
            if (detail.RequireRevealReason)
                facts.Add(("Passwords", "A reason is asked before each is shown or copied"));
            if (facts.Count > 0)
                Detail.Children.Add(Facts(facts));

            // Where the person may make changes, the cards show even when empty, so there's somewhere to add the first one.
            var changeable = canWrite && detail.CanEdit;
            var contactRows = contacts.Select(c => ContactRow(c, changeable)).ToList();
            var locationRows = locations.Select(l => LocationRow(l, changeable)).ToList();
            if (changeable)
            {
                contactRows.Add(AddRow("Add contact", "contact", clientId));
                locationRows.Add(AddRow("Add location", "location", clientId));
            }
            if (contactRows.Count > 0)
                Detail.Children.Add(Card("Contacts", [.. contactRows]));
            if (locationRows.Count > 0)
                Detail.Children.Add(Card("Locations", [.. locationRows]));
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex) when (ex is AtlasApiException or HttpRequestException)
        {
            Fail(ex);
        }
    }

    private static string Access(string level) => level switch
    {
        "edit_passwords" => "You can edit, including passwords",
        "edit" => "You can edit",
        "read" => "Read only",
        _ => "",
    };

    private UIElement ContactRow(ContactInfo contact, bool changeable)
    {
        var actions = new List<Button>();
        if (contact.Email.Length > 0)
            actions.Add(IconButton("", $"Copy {contact.Email}", (_, _) => Copy(contact.Email, "Email address copied.")));
        var phone = contact.Phone.Length > 0 ? contact.Phone : contact.Mobile;
        if (phone.Length > 0)
            actions.Add(IconButton("", $"Copy {phone}", (_, _) => Copy(phone, "Phone number copied.")));
        if (changeable)
            actions.AddRange(PersonActions("contact", contact.Id, contact.Name, contact, contact.ClientId));
        var label = contact.Primary ? $"{contact.Name} · primary" : contact.Name;
        return Field(label, Value(Join(contact.Title, contact.Email, phone)), [.. actions]);
    }

    private UIElement LocationRow(LocationInfo location, bool changeable)
    {
        var label = location.Primary ? $"{location.Name} · primary" : location.Name;
        var address = location.OneLine;
        var actions = new List<Button>();
        if (address.Length > 0)
            actions.Add(IconButton("", "Copy address", (_, _) => Copy(address, "Address copied.")));
        if (changeable)
            actions.AddRange(PersonActions("location", location.Id, location.Name, location, location.ClientId));
        return Field(label, Value(Join(address, location.Phone)), [.. actions]);
    }

    /// <summary>The quick note, with Edit where the person may change it. Saving says whose words won if two people edited.</summary>
    private UIElement QuickNoteCard(ClientDetail detail)
    {
        var host = new StackPanel();
        void Reading()
        {
            host.Children.Clear();
            var grid = new Grid { Padding = new Thickness(16, 12, 8, 12), ColumnSpacing = 8 };
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var text = new StackPanel { Spacing = 4 };
            text.Children.Add(new TextBlock
            {
                Text = detail.Notes.Length > 0 ? detail.Notes : "No quick note yet. Use it for what everyone should know before touching anything here.",
                TextWrapping = TextWrapping.Wrap,
                IsTextSelectionEnabled = true,
                Foreground = detail.Notes.Length > 0 ? (Brush)Application.Current.Resources["TextFillColorPrimaryBrush"] : Secondary(),
            });
            if (detail.NotesUpdatedAt is { } at)
                text.Children.Add(new TextBlock { Text = Join($"Edited {When(at)}", detail.NotesUpdatedByName is { } by ? $"by {by}" : null), FontSize = 12, Foreground = Secondary() });
            grid.Children.Add(text);
            if (canWrite && detail.CanEdit)
            {
                var edit = new Button { Content = "Edit", VerticalAlignment = VerticalAlignment.Top };
                edit.Click += (_, _) => Editing();
                Grid.SetColumn(edit, 1);
                grid.Children.Add(edit);
            }
            host.Children.Add(grid);
        }
        void Editing()
        {
            host.Children.Clear();
            var panel = new StackPanel { Padding = new Thickness(16, 12, 16, 14), Spacing = 10 };
            var box = new TextBox
            {
                Text = detail.Notes,
                AcceptsReturn = true,
                TextWrapping = TextWrapping.Wrap,
                MaxLength = 5000,
                MinHeight = 90,
                PlaceholderText = "What everyone should know before touching anything here",
            };
            AutomationProperties.SetName(box, "Quick note");
            var save = new Button { Content = "Save", Style = (Style)Application.Current.Resources["AccentButtonStyle"] };
            var cancel = new Button { Content = "Cancel" };
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            buttons.Children.Add(save);
            buttons.Children.Add(cancel);
            panel.Children.Add(box);
            panel.Children.Add(buttons);
            host.Children.Add(panel);
            box.Focus(FocusState.Programmatic);
            cancel.Click += (_, _) => Reading();
            save.Click += async (_, _) =>
            {
                if (app.Client is not { } client)
                    return;
                save.IsEnabled = false;
                try
                {
                    detail = await client.SaveQuickNoteAsync(detail.Id, box.Text.Trim(), detail.NotesVersion);
                    Show("Quick note saved.", InfoBarSeverity.Success);
                    Reading();
                }
                catch (AtlasApiException ex) when (ex.Status == System.Net.HttpStatusCode.Conflict)
                {
                    Show("Someone else changed the quick note while you were editing. Copy your text, then reopen the client to see theirs.", InfoBarSeverity.Warning);
                    save.IsEnabled = true;
                }
                catch (Exception ex) when (ex is AtlasApiException or HttpRequestException)
                {
                    Fail(ex);
                    save.IsEnabled = true;
                }
            };
        }
        Reading();
        return Card("Quick note", host);
    }

    /// <summary>Sign-ins from before the app could make changes may only read; signing in again asks for more.</summary>
    private InfoBar SignInAgainNotice()
    {
        var again = new Button { Content = "Sign in again" };
        again.Click += (_, _) => _ = app.SignOutAsync();
        return new InfoBar
        {
            IsOpen = true,
            IsClosable = false,
            Severity = InfoBarSeverity.Informational,
            Title = "Make changes from here",
            Message = "This sign-in can only read. Sign in again once to edit from Atlas for Windows; everything you change is recorded under your name.",
            ActionButton = again,
            Margin = new Thickness(0, 0, 0, 4),
        };
    }

    // ---------- favorites ----------
    /// <summary>What the current page is, as something that can be starred: a client, or an item.</summary>
    private (string Kind, string Id)? Starrable() => trail.LastOrDefault() switch
    {
        { Kind: "client", ClientId: { } id } => ("client", id),
        { Kind: "item", Item: { Kind: "password" or "asset" or "document" } row } => (row.Kind, row.Id),
        _ => null,
    };

    private void ShowStar()
    {
        if (Starrable() is not { } thing)
        {
            StarButton.Visibility = Visibility.Collapsed;
            return;
        }
        var on = starred.Contains($"{thing.Kind}:{thing.Id}");
        StarButton.Visibility = Visibility.Visible;
        StarIcon.Glyph = on ? "" : "";
        StarText.Text = on ? "In favorites" : "Add to favorites";
        ToolTipService.SetToolTip(StarButton, on ? "Remove from favorites" : "Keep this on Home");
    }

    private async void Star_Click(object sender, RoutedEventArgs e)
    {
        if (Starrable() is not { } thing || app.Client is not { } client)
            return;
        var key = $"{thing.Kind}:{thing.Id}";
        var on = !starred.Contains(key);
        try
        {
            StarButton.IsEnabled = false;
            await client.SetFavoriteAsync(thing.Kind, thing.Id, on);
            if (on)
                starred.Add(key);
            else
                starred.Remove(key);
            ShowStar();
            Show(on ? "Added to favorites. It's on Home." : "Removed from favorites.", InfoBarSeverity.Success);
        }
        catch (AtlasApiException ex) when (ex.Code == "api_scope")
        {
            Show("Your Atlas server needs updating before favorites can be changed here. Star it in Atlas in your browser for now.", InfoBarSeverity.Warning);
        }
        catch (Exception ex) when (ex is AtlasApiException or HttpRequestException)
        {
            Fail(ex);
        }
        finally
        {
            StarButton.IsEnabled = true;
        }
    }

    // ---------- related items, files, earlier passwords, and archived items ----------
    /// <summary>The cards under an item: what it's linked to, its files, and (for a password) its earlier versions.</summary>
    private async Task ShowExtrasAsync(Row row, AtlasClient client, CancellationToken cancel)
    {
        if (row.Kind is not ("password" or "asset" or "document"))
            return;
        // An Atlas older than this app, or a list this person can't see, just leaves its card out.
        static async Task<IReadOnlyList<T>> Maybe<T>(Task<IReadOnlyList<T>> task)
        {
            try
            {
                return await task;
            }
            catch (AtlasApiException)
            {
                return [];
            }
        }
        var relatedTask = Maybe(client.ListRelatedAsync(row.Kind, row.Id, cancel));
        var filesTask = Maybe(client.ListAttachmentsAsync(row.Kind, row.Id, cancel));
        var historyTask = row.Kind == "password" ? Maybe(client.ListPasswordHistoryAsync(row.Id, cancel)) : Task.FromResult<IReadOnlyList<PasswordVersion>>([]);
        await Task.WhenAll(relatedTask, filesTask, historyTask);
        if (cancel.IsCancellationRequested || current != row)
            return;
        if (relatedTask.Result is { Count: > 0 } related)
            AddSide(Card("Related", [.. related.Select(RelatedRow)]));
        if (filesTask.Result is { Count: > 0 } files)
            AddSide(Card("Files", [.. files.Select(f => FileRow(row, f))]));
        if (historyTask.Result is { Count: > 0 } history)
            AddSide(Card("Earlier passwords", [.. history.Select(v => VersionRow(row, v))]));
    }

    private UIElement RelatedRow(RelatedItem item) => Field(
        Kind(item.Type),
        Value(Join(item.Title, item.Subtitle, item.Note)),
        IconButton("", $"Open {item.Title}", (_, _) =>
            Go(new Place("item", item.Title, Item: new Row(item.Type, item.Id, item.Title, item.Subtitle, item.ClientId, item.ClientName)))));

    private UIElement FileRow(Row item, AttachmentInfo file) => Field(
        file.Filename,
        Value(Join(Size(file.Size), file.UploadedByName is { Length: > 0 } by ? $"added by {by}" : null, When(file.CreatedAt))),
        IconButton("", $"Save {file.Filename}…", (_, _) => _ = SaveFileAsync(item, file)));

    private static string Size(long bytes) => bytes switch
    {
        < 1024 => $"{bytes} bytes",
        < 1024 * 1024 => $"{bytes / 1024.0:0.#} KB",
        _ => $"{bytes / 1024.0 / 1024.0:0.#} MB",
    };

    /// <summary>
    /// Saves a file where the person chooses. Nothing is opened, so a program attached to an item never runs from
    /// here. A password's files are recorded like a reveal and may need a reason.
    /// </summary>
    private async Task SaveFileAsync(Row item, AttachmentInfo file, string reason = "")
    {
        if (item.Kind == "password" && !await SecretCheckAsync("Save a password attachment"))
            return;
        if (app.Client is not { } client)
            return;
        var picker = new global::Windows.Storage.Pickers.FileSavePicker
        {
            SuggestedFileName = Path.GetFileNameWithoutExtension(file.Filename),
            SuggestedStartLocation = global::Windows.Storage.Pickers.PickerLocationId.Downloads,
        };
        var extension = Path.GetExtension(file.Filename);
        if (extension.Length == 0)
            extension = ".bin";
        picker.FileTypeChoices.Add($"{extension.TrimStart('.').ToUpperInvariant()} file", [extension]);
        InitializeWithWindow.Initialize(picker, hwnd);
        var target = await picker.PickSaveFileAsync();
        if (target is null)
            return;
        try
        {
            var bytes = await client.DownloadAttachmentAsync(item.Kind, item.Id, file.Id, reason);
            await global::Windows.Storage.FileIO.WriteBytesAsync(target, bytes);
            Show($"Saved {target.Name}.", InfoBarSeverity.Success);
        }
        catch (AtlasApiException ex) when (ex.Code == "reason_required" && reason.Length == 0)
        {
            if (await AskReasonAsync() is { } given)
                await SaveFileAsync(item, file, given);
        }
        catch (Exception ex) when (ex is AtlasApiException or HttpRequestException)
        {
            Fail(ex);
        }
        catch (IOException ex)
        {
            Show($"The file couldn't be saved: {ex.Message}", InfoBarSeverity.Error);
        }
    }

    /// <summary>An earlier version of a password: show it, copy it, or (with permission to edit) make it current again.</summary>
    private UIElement VersionRow(Row item, PasswordVersion version)
    {
        const string masked = "••••••••••••";
        var value = Value(masked, mono: true);
        var actions = new List<Button>
        {
            IconButton("", "Show for 30 seconds", async (_, _) =>
            {
                if (await RevealOldAsync(item.Id, version.Id) is not { } secret)
                    return;
                HideSecrets();
                value.Text = secret;
                shown = (value, masked);
                hideTimer = new DispatcherTimer { Interval = ShowFor };
                hideTimer.Tick += (_, _) => HideSecrets();
                hideTimer.Start();
            }),
            IconButton("", "Copy", async (_, _) =>
            {
                if (await RevealOldAsync(item.Id, version.Id) is not { } secret)
                    return;
                clipboard.Copy(secret, sensitive: true);
                Show("Earlier password copied. The clipboard clears in 30 seconds.", InfoBarSeverity.Success);
            }),
        };
        if (canWrite)
            actions.Add(IconButton("", "Make this the current password again", (_, _) => _ = RestoreVersionAsync(item, version)));
        return Field($"Replaced {When(version.CreatedAt)} by {version.ChangedByName}", value, [.. actions]);
    }

    private async Task<string?> RevealOldAsync(string passwordId, string versionId)
    {
        if (!await SecretCheckAsync("Show or copy an earlier password"))
            return null;
        if (app.Client is not { } client)
            return null;
        try
        {
            return (await client.RevealOldPasswordAsync(passwordId, versionId)).Value;
        }
        catch (AtlasApiException ex) when (ex.Code == "reason_required")
        {
            if (await AskReasonAsync() is not { } given)
                return null;
            try
            {
                return (await client.RevealOldPasswordAsync(passwordId, versionId, given)).Value;
            }
            catch (Exception again) when (again is AtlasApiException or HttpRequestException)
            {
                Fail(again);
                return null;
            }
        }
        catch (Exception ex) when (ex is AtlasApiException or HttpRequestException)
        {
            Fail(ex);
            return null;
        }
    }

    /// <summary>Saves an earlier password as the current one. The one it replaces goes into the history in turn.</summary>
    private async Task RestoreVersionAsync(Row item, PasswordVersion version)
    {
        if (app.Client is not { } client || password is not { } entry || entry.Id != item.Id)
            return;
        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            Title = "Make this the current password again?",
            Content = $"The password from {When(version.CreatedAt)} replaces the current one, which is kept in the history. Change it on the device or account too if it's no longer in use there.",
            PrimaryButtonText = "Restore",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Close,
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary || await RevealOldAsync(item.Id, version.Id) is not { } secret)
            return;
        try
        {
            await client.UpdatePasswordAsync(entry.Id, entry.Version, new PasswordDraft(entry.Name, entry.Username, entry.Url, secret, null, null, entry.RotationDays, entry.FolderId));
            ShowPlace();
            Show("Restored. The password it replaced is in the history.", InfoBarSeverity.Success);
        }
        catch (AtlasApiException ex) when (ex.Status == System.Net.HttpStatusCode.Conflict)
        {
            Show("Someone changed this password meanwhile. Open it again and retry.", InfoBarSeverity.Warning);
        }
        catch (Exception ex) when (ex is AtlasApiException or HttpRequestException)
        {
            Fail(ex);
        }
    }

    private void ArchivedToggle_Click(object sender, RoutedEventArgs e) => ShowPlace();

    /// <summary>Brings an archived item back into the lists and search.</summary>
    private async void Restore_Click(object sender, RoutedEventArgs e)
    {
        if (current is not { Archived: true } row || app.Client is not { } client)
            return;
        try
        {
            switch (row.Kind)
            {
                case "password":
                    await client.ArchivePasswordAsync(row.Id, archived: false);
                    break;
                case "asset":
                    await client.ArchiveAssetAsync(row.Id, archived: false);
                    break;
                case "document":
                    await client.ArchiveDocumentAsync(row.Id, archived: false);
                    break;
                default:
                    return;
            }
            Back();
            Show($"{row.Title} restored.", InfoBarSeverity.Success);
        }
        catch (Exception ex) when (ex is AtlasApiException or HttpRequestException)
        {
            Fail(ex);
        }
    }

    // ---------- Windows Hello and locking ----------
    private readonly HelloPolicy hello = new(TimeProvider.System);
    private bool helloAvailable;
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? idleTimer;
    private (Visibility Main, Visibility Setup)? beforeLock;

    private static readonly (string Label, int Minutes)[] GraceChoices = [("Every time", 0), ("After 5 minutes", 5), ("After 15 minutes", 15)];
    private static readonly (string Label, int Minutes)[] LockChoices = [("After 5 minutes", 5), ("After 15 minutes", 15), ("After 30 minutes", 30), ("After 1 hour", 60), ("Never", 0)];

    /// <summary>
    /// Finds out whether Windows Hello is set up here, applies the person's choices, and starts watching for the
    /// computer being left alone. Without Windows Hello nothing is asked and nothing locks.
    /// </summary>
    private async Task SetUpHelloAsync()
    {
        helloAvailable = await WindowsHello.IsAvailableAsync();
        hello.Apply(app.Settings);
        BuildHelloMenu();
        idleTimer = DispatcherQueue.CreateTimer();
        idleTimer.Interval = TimeSpan.FromSeconds(20);
        idleTimer.Tick += (_, _) =>
        {
            if (helloAvailable && hello.ShouldLock(Native.IdleTime()))
                LockApp($"It locked after {Minutes(hello.LockAfter!.Value)} without use.");
        };
        idleTimer.Start();
    }

    private static string Minutes(TimeSpan span) => span.TotalMinutes >= 60 && span.TotalMinutes % 60 == 0
        ? $"{span.TotalHours:0} hour{(span.TotalHours == 1 ? "" : "s")}"
        : $"{span.TotalMinutes:0} minutes";

    /// <summary>The Windows Hello choices in the account menu.</summary>
    private void BuildHelloMenu()
    {
        HelloMenu.Items.Clear();
        if (!helloAvailable)
        {
            HelloMenu.Items.Add(new MenuFlyoutItem { Text = "Windows Hello isn't set up on this PC", IsEnabled = false });
            HelloMenu.Items.Add(new MenuFlyoutItem { Text = "Set it up in Windows Settings › Accounts › Sign-in options", IsEnabled = false });
            return;
        }
        var settings = app.Settings;
        var ask = new ToggleMenuFlyoutItem { Text = "Ask before showing or copying a password", IsChecked = settings.HelloForSecrets };
        ask.Click += (_, _) => ChangeHello(s => s with { HelloForSecrets = ask.IsChecked });
        HelloMenu.Items.Add(ask);
        HelloMenu.Items.Add(new MenuFlyoutSeparator());
        HelloMenu.Items.Add(new MenuFlyoutItem { Text = "Ask again", IsEnabled = false });
        foreach (var (label, minutes) in GraceChoices)
        {
            var choice = new RadioMenuFlyoutItem { Text = label, GroupName = "grace", IsChecked = settings.HelloGraceMinutes == minutes };
            choice.Click += (_, _) => ChangeHello(s => s with { HelloGraceMinutes = minutes });
            HelloMenu.Items.Add(choice);
        }
        HelloMenu.Items.Add(new MenuFlyoutSeparator());
        HelloMenu.Items.Add(new MenuFlyoutItem { Text = "Lock when the PC isn't used", IsEnabled = false });
        foreach (var (label, minutes) in LockChoices)
        {
            var choice = new RadioMenuFlyoutItem { Text = label, GroupName = "lock", IsChecked = settings.LockAfterMinutes == minutes };
            choice.Click += (_, _) => ChangeHello(s => s with { LockAfterMinutes = minutes });
            HelloMenu.Items.Add(choice);
        }
        HelloMenu.Items.Add(new MenuFlyoutSeparator());
        var lockNow = new MenuFlyoutItem { Text = "Lock now", Icon = new FontIcon { Glyph = "" } };
        lockNow.Click += (_, _) => LockApp("You locked it.");
        HelloMenu.Items.Add(lockNow);
    }

    private void ChangeHello(Func<AppSettings, AppSettings> change)
    {
        app.UpdateSettings(change);
        hello.Apply(app.Settings);
        BuildHelloMenu();
    }

    /// <summary>
    /// Before a password or code is shown or copied: asks for Windows Hello unless a check was passed in the last few
    /// minutes (or Windows Hello isn't set up here). False when it didn't confirm the person.
    /// </summary>
    private async Task<bool> SecretCheckAsync(string message)
    {
        if (!helloAvailable || !hello.SecretNeedsCheck)
            return true;
        if (await WindowsHello.VerifyAsync(hwnd, message) is { } problem)
        {
            Show($"{problem} Nothing was shown or copied.", InfoBarSeverity.Warning);
            return false;
        }
        hello.Verified();
        return true;
    }

    /// <summary>Covers the window until Windows Hello confirms the person. Secrets on screen are hidden first.</summary>
    private void LockApp(string why)
    {
        if (!helloAvailable)
            return;
        hello.Lock();
        HideSecrets();
        if (LockPanel.Visibility == Visibility.Visible)
            return;
        beforeLock = (MainPanel.Visibility, SetupPanel.Visibility);
        MainPanel.Visibility = Visibility.Collapsed;
        SetupPanel.Visibility = Visibility.Collapsed;
        QueryBox.IsEnabled = false;
        AccountButton.IsEnabled = false;
        LockReason.Text = $"{why} Nothing shows until Windows Hello confirms it's you.";
        LockPanel.Visibility = Visibility.Visible;
    }

    private async void Unlock_Click(object sender, RoutedEventArgs e)
    {
        if (await WindowsHello.VerifyAsync(hwnd, "Unlock Atlas") is { } problem)
        {
            LockReason.Text = problem;
            return;
        }
        hello.Verified();
        LockPanel.Visibility = Visibility.Collapsed;
        QueryBox.IsEnabled = true;
        AccountButton.IsEnabled = true;
        if (beforeLock is { } was)
        {
            MainPanel.Visibility = was.Main;
            SetupPanel.Visibility = was.Setup;
        }
        beforeLock = null;
    }

    // ---------- ScreenConnect ----------
    private ScreenConnectInfo? screenConnect;
    private Uri? connectLink;

    /// <summary>Connect, for a device, when the organization has set its ScreenConnect address in Atlas.</summary>
    private void ShowConnect(AssetSummary asset)
    {
        layouts.TryGetValue(asset.LayoutId, out var layout);
        connectLink = screenConnect?.LinkFor(asset, layout);
        if (connectLink is null)
        {
            ConnectButton.Visibility = Visibility.Collapsed;
            return;
        }
        var joins = ScreenConnectInfo.SessionIdOf(asset, layout) is not null;
        ConnectText.Text = joins ? "Connect" : "Find in ScreenConnect";
        var tip = joins
            ? "Join this device's ScreenConnect session."
            : $"Open ScreenConnect searching for {ScreenConnectInfo.NameToFind(asset, layout)}. Add the session ID to the asset to join it directly.";
        ToolTipService.SetToolTip(ConnectButton, tip);
        AutomationProperties.SetName(ConnectButton, ConnectText.Text);
        ConnectButton.Visibility = Visibility.Visible;
    }

    private void Connect_Click(object sender, RoutedEventArgs e)
    {
        if (connectLink is null)
            return;
        _ = Launcher.LaunchUriAsync(connectLink);
        Show(ConnectText.Text == "Connect" ? "Opening the session in ScreenConnect…" : "Opening ScreenConnect…", InfoBarSeverity.Informational);
    }

    // ---------- updating the app ----------
    private string? dismissedUpdate;
    private bool installingUpdate;

    /// <summary>Shows the update bar when Atlas offers a newer version of this app, unless it was put away for that version.</summary>
    internal void ShowUpdate()
    {
        if (installingUpdate)
            return;
        var release = app.AvailableUpdate;
        if (release is null || dismissedUpdate == release.LatestVersion)
        {
            UpdateBar.IsOpen = false;
            return;
        }
        UpdateBar.Severity = InfoBarSeverity.Informational;
        UpdateBar.Title = $"Atlas for Windows {release.LatestVersion} is available";
        UpdateBar.Message = $"You have {AppInfo.VersionText}. It installs in a few seconds, and the app opens again by itself.";
        UpdateButton.Content = "Install and restart";
        UpdateButton.IsEnabled = true;
        UpdateProgress.Visibility = Visibility.Collapsed;
        UpdateBrowserLink.Visibility = Visibility.Collapsed;
        UpdateBar.IsOpen = true;
    }

    private void UpdateBar_Closed(InfoBar sender, InfoBarClosedEventArgs args) => dismissedUpdate = app.AvailableUpdate?.LatestVersion;

    private async void InstallUpdate_Click(object sender, RoutedEventArgs e)
    {
        if (installingUpdate)
            return;
        installingUpdate = true;
        UpdateButton.IsEnabled = false;
        UpdateBrowserLink.Visibility = Visibility.Collapsed;
        UpdateProgress.Value = 0;
        UpdateProgress.Visibility = Visibility.Visible;
        UpdateBar.IsClosable = false;
        UpdateBar.Message = "Downloading…";
        var progress = new Progress<double>(share =>
        {
            UpdateProgress.Value = share * 100;
            UpdateBar.Message = share < 1 ? $"Downloading… {share:P0}" : "Checked. Installing; the app closes and opens again in a moment.";
        });
        try
        {
            await app.InstallUpdateAsync(progress);
        }
        catch (Exception ex) when (ex is UpdateFailedException or HttpRequestException or IOException or TaskCanceledException or System.ComponentModel.Win32Exception)
        {
            UpdateBar.Severity = InfoBarSeverity.Error;
            UpdateBar.Title = "The update didn't install";
            UpdateBar.Message = ex switch
            {
                UpdateFailedException failed => failed.Message,
                HttpRequestException http => ConnectionProblem.Describe(http),
                System.ComponentModel.Win32Exception => "Windows didn't start the setup program. You can download it in your browser instead.",
                _ => "The download stopped. Check the connection and try again.",
            };
            UpdateButton.Content = "Try again";
            UpdateButton.IsEnabled = true;
            UpdateProgress.Visibility = Visibility.Collapsed;
            UpdateBrowserLink.Visibility = Visibility.Visible;
        }
        finally
        {
            installingUpdate = false;
            UpdateBar.IsClosable = true;
        }
    }

    private void UpdateBrowser_Click(object sender, RoutedEventArgs e)
    {
        if (app.AvailableUpdate?.DownloadLink is { } link)
            _ = Launcher.LaunchUriAsync(link);
    }

    private async void CheckUpdates_Click(object sender, RoutedEventArgs e)
    {
        switch (await app.CheckForUpdateNowAsync())
        {
            case true:
                dismissedUpdate = null;
                ShowUpdate();
                break;
            case false:
                Show($"You have the newest version, {AppInfo.VersionText}.", InfoBarSeverity.Success);
                break;
            default:
                Show("Atlas couldn't be asked about updates just now. Try again later.", InfoBarSeverity.Warning);
                break;
        }
    }

    private void OpenAtlas_Click(object sender, RoutedEventArgs e)
    {
        if (app.Client is { } client)
            _ = Launcher.LaunchUriAsync(client.Address.Origin);
    }

    private void Refresh_Click(object sender, RoutedEventArgs e)
    {
        _ = LoadAccountAsync();
        ShowPlace();
    }

    private void SignOut_Click(object sender, RoutedEventArgs e) => _ = app.SignOutAsync();

    // ---------- list pages ----------
    private async Task LoadPageAsync()
    {
        if (app.Client is not { } client || trail.Count == 0)
            return;
        var place = trail[^1];
        if (place.Kind == "item")
            return;
        listCancel?.Cancel();
        var cancel = listCancel = new CancellationTokenSource();
        ListLoading.Visibility = Visibility.Visible;
        try
        {
            List<Row> rows;
            Func<Row, string>? groupBy = null;
            var empty = "Nothing here yet.";
            var kind = place.Kind == "client" ? place.Tab : place.Kind;
            var clientId = place.ClientId;
            showingArchived = ArchivedToggle.IsChecked == true && kind is "passwords" or "assets" or "documents";
            if (showingArchived)
                empty = "Nothing archived here.";
            switch (kind)
            {
                case "home":
                    rows = [];
                    try
                    {
                        var favorites = await client.ListFavoritesAsync(cancel.Token);
                        starred.Clear();
                        foreach (var f in favorites)
                            starred.Add($"{f.Type}:{f.Id}");
                        rows.AddRange(favorites
                            .Where(f => f.Type is "password" or "asset" or "document" or "client")
                            .Select(f => new Row(f.Type, f.Id, f.Name, Join(Kind(f.Type), f.ClientName), f.ClientId, "Favorites")));
                    }
                    catch (AtlasApiException ex) when (ex.Code == "api_scope")
                    {
                        // An Atlas older than this app doesn't share favorites with it yet.
                    }
                    rows.AddRange(recent.Select(r => r with { ClientName = "Recently opened", Subtitle = Join(Kind(r.Kind), r.ClientName) }));
                    groupBy = r => r.ClientName!;
                    empty = "Nothing here yet. Open a client or an item and choose Add to favorites at the top to keep it here. What you open also shows up here.";
                    break;
                case "clients":
                    clientCache = await LoadClientRowsAsync(client, cancel.Token);
                    FillStatuses();
                    rows = ClientRows();
                    empty = "You don't have access to any clients yet.";
                    break;
                case "passwords":
                {
                    var listed = showingArchived ? client.ListArchivedPasswordsAsync(clientId, cancel.Token) : client.ListPasswordsAsync(clientId, cancel.Token);
                    dueById = showingArchived ? new Dictionary<string, ExpirationItem>() : await LoadDueAsync(client, cancel.Token);
                    rows = [.. (await listed).Select(p => PasswordRow(p) with { Archived = showingArchived })];
                    break;
                }
                case "assets":
                {
                    var listed = showingArchived ? client.ListArchivedAssetsAsync(clientId, cancel.Token) : client.ListAssetsAsync(clientId, cancel.Token);
                    dueById = showingArchived ? new Dictionary<string, ExpirationItem>() : await LoadDueAsync(client, cancel.Token);
                    assetCache = await listed;
                    FillTypes();
                    rows = AssetRows();
                    break;
                }
                case "documents":
                {
                    var listed = showingArchived ? client.ListArchivedDocumentsAsync(clientId, cancel.Token) : client.ListDocumentsAsync(clientId, cancel.Token);
                    dueById = showingArchived ? new Dictionary<string, ExpirationItem>() : await LoadDueAsync(client, cancel.Token);
                    rows = [.. (await listed).Select(d => DocumentRow(d) with { Archived = showingArchived })];
                    break;
                }
                case "search":
                    rows = [.. (await client.SearchAsync(place.Query ?? "", 40, cancel.Token))
                        .Select(r => new Row(r.Type, r.Id, r.Title, Join(Kind(r.Type), r.ClientName, Snippet(r.Snippet, r.Title)), r.ClientId, r.ClientName))];
                    groupBy = r => r.Kind switch { "client" => "Clients", "password" => "Passwords", "asset" => "Assets", "document" => "Documents", _ => "Other" };
                    empty = "Nothing you can see matches that.";
                    break;
                default:
                    rows = [];
                    break;
            }
            if (kind is "passwords" or "assets" or "documents" && clientId is null)
                groupBy = r => r.ClientName ?? "Knowledge base";
            if (cancel.IsCancellationRequested)
                return;
            TypeFilter.Visibility = kind is "assets" or "clients" ? Visibility.Visible : Visibility.Collapsed;
            ClientHeader.Visibility = kind == "clients" ? Visibility.Visible : Visibility.Collapsed;
            ShowItemHeader(kind);
            // Another page may have opened while this one loaded; its own load shows its rows.
            if (trail.Count == 0 || trail[^1] != place)
                return;
            loaded = rows;
            loadedFor = place;
            grouping = groupBy;
            ListEmptyText.Text = place.Kind == "client" ? $"{place.Title} has no {place.Tab} in Atlas yet." : empty;
            Render();
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex) when (ex is AtlasApiException or HttpRequestException)
        {
            Fail(ex);
        }
        finally
        {
            if (!cancel.IsCancellationRequested)
                ListLoading.Visibility = Visibility.Collapsed;
        }
    }

    /// <summary>Shows the loaded rows that match the filter, under headings when the list spans many clients.</summary>
    private void Render()
    {
        var place = trail[^1];
        // Rows only ever show on the page they were loaded for; until this page's arrive, the list stays empty.
        if (loadedFor != place)
        {
            Results.ItemsSource = null;
            ListEmpty.Visibility = Visibility.Collapsed;
            return;
        }
        var filter = FilterBox.Text.Trim();
        var shown = loaded
            .Where(r => filter.Length == 0 || r.Title.Contains(filter, StringComparison.CurrentCultureIgnoreCase) || r.Subtitle.Contains(filter, StringComparison.CurrentCultureIgnoreCase))
            .ToList();
        if (place.Kind != "home")
            shown = [.. shown.OrderBy(r => r.Title, StringComparer.CurrentCultureIgnoreCase)];
        if (grouping is not null)
        {
            var first = new[] { "Favorites", "Recently opened", "Clients", "Passwords", "Assets", "Documents" };
            var groups = shown
                .GroupBy(grouping)
                .OrderBy(g => Array.IndexOf(first, g.Key) is var i and >= 0 ? i.ToString() : "9" + g.Key, StringComparer.CurrentCultureIgnoreCase)
                .Select(g => new RowGroup(g.Key, g))
                .ToList();
            Results.ItemsSource = new Microsoft.UI.Xaml.Data.CollectionViewSource { IsSourceGrouped = true, Source = groups }.View;
        }
        else
        {
            Results.ItemsSource = shown;
        }
        var noun = place.Kind switch
        {
            "clients" => "client",
            "home" or "search" => "item",
            "client" => place.Tab.TrimEnd('s'),
            _ => place.Kind.TrimEnd('s'),
        };
        PageInfo.Text = shown.Count == loaded.Count
            ? $"{loaded.Count:N0} {noun}{(loaded.Count == 1 ? "" : "s")}"
            : $"{shown.Count:N0} of {loaded.Count:N0} {noun}s";
        if (place.Kind == "clients" && clientTotals.Length > 0 && shown.Count == clientCache.Count)
            PageInfo.Text = clientTotals;
        if (place.Kind == "client")
        {
            var tabs = new[] { (PasswordsTab, "Passwords", "passwords"), (AssetsTab, "Assets", "assets"), (DocumentsTab, "Documents", "documents") };
            foreach (var (item, label, tab) in tabs)
                item.Text = tab == place.Tab ? $"{label} ({loaded.Count})" : label;
        }
        ListEmpty.Visibility = shown.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        if (shown.Count == 0 && loaded.Count > 0)
            ListEmptyText.Text = "Nothing in this list matches that.";
    }

    private void FilterBox_TextChanged(object sender, TextChangedEventArgs e)
    {
        if (trail.Count > 0 && trail[^1].Kind != "item")
            Render();
    }

    // The asset types present in the list, for the filter.
    private void FillTypes()
    {
        var previous = (TypeFilter.SelectedItem as TypeChoice)?.LayoutId;
        var choices = new List<TypeChoice> { new(null, "All types") };
        choices.AddRange(assetCache
            .GroupBy(a => a.LayoutId)
            .Select(g => new TypeChoice(g.Key, $"{g.First().LayoutName} ({g.Count()})"))
            .OrderBy(c => c.Label, StringComparer.CurrentCultureIgnoreCase));
        fillingTypes = true;
        TypeFilter.ItemsSource = choices;
        TypeFilter.SelectedItem = choices.FirstOrDefault(c => c.LayoutId == previous) ?? choices[0];
        fillingTypes = false;
    }

    private List<Row> AssetRows()
    {
        var layoutId = (TypeFilter.SelectedItem as TypeChoice)?.LayoutId;
        return [.. assetCache
            .Where(a => layoutId is null || a.LayoutId == layoutId)
            .Select(a => AssetRow(a) with { Archived = showingArchived })];
    }

    private void TypeFilter_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (fillingTypes || trail.Count == 0)
            return;
        // The filter is shared by the Clients and Assets lists: act only for the one on screen, once it has loaded.
        var place = trail[^1];
        var kind = place.Kind == "client" ? place.Tab : place.Kind;
        if (kind is not ("assets" or "clients") || loadedFor != place)
            return;
        loaded = kind == "clients" ? ClientRows() : AssetRows();
        Render();
    }

    // ---------- the Passwords, Assets, and Documents lists ----------
    private Dictionary<string, ExpirationItem> dueById = [];
    private bool showingArchived;

    private static readonly string[] StrengthWords = ["Very weak", "Weak", "Fair", "Good", "Strong"];

    /// <summary>What comes due in the next 60 days (rotation, expiry, review), by kind and id. Nothing if Atlas won't say.</summary>
    private static async Task<Dictionary<string, ExpirationItem>> LoadDueAsync(AtlasClient client, CancellationToken cancel)
    {
        try
        {
            return (await client.GetExpirationsAsync(60, cancel))
                .GroupBy(e => $"{e.Kind}:{e.Id}")
                .ToDictionary(g => g.Key, g => g.MinBy(e => e.DaysLeft)!);
        }
        catch (AtlasApiException)
        {
            return [];
        }
    }

    /// <summary>The Due column: when, coloured by how soon, and what it is.</summary>
    private (string When, string Tone, string What) DueFor(string kind, string id)
    {
        if (!dueById.TryGetValue($"{kind}:{id}", out var due))
            return ("", "quiet", "");
        var when = due.DaysLeft switch
        {
            < -1 => $"{-due.DaysLeft} days overdue",
            -1 => "1 day overdue",
            0 => "Due today",
            1 => "Tomorrow",
            _ => $"In {due.DaysLeft} days",
        };
        var tone = due.DaysLeft < 0 ? "critical" : due.DaysLeft <= 14 ? "caution" : "neutral";
        return (when, tone, due.Label);
    }

    private static (string When, string Who) Changed(string updatedAt, string? by) =>
        (Ago(updatedAt) is { Length: > 0 } ago ? char.ToUpper(ago[0], CultureInfo.CurrentCulture) + ago[1..] : "", by is { Length: > 0 } ? $"by {by}" : "");

    private Row PasswordRow(PasswordSummary p)
    {
        var host = Uri.TryCreate(p.Url, UriKind.Absolute, out var uri) ? uri.Authority : p.Url;
        var (when, tone, what) = DueFor("password", p.Id);
        var (changed, by) = Changed(p.UpdatedAt, p.UpdatedByName);
        var strength = Math.Clamp(p.Strength, -1, 4);
        var warning = p.BreachCount is > 0 ? $"In {p.BreachCount} breach{(p.BreachCount == 1 ? "" : "es")}"
            : p.Reused > 1 ? $"Used {p.Reused} times"
            : "";
        var facts = new ItemFacts(
            CategoryGlyph(p.Category, p.Kind),
            Tile(Array.IndexOf(CategoryOrder, p.Category) is var i and >= 0 ? i : CategoryOrder.Length),
            Join(p.Username.Length > 0 ? p.Username : "No username", host, p.FolderName),
            p.HasTotp ? "2FA" : "",
            p.RequireReason ? "Reason" : p.Restricted ? "Restricted" : "",
            p.Favorite || starred.Contains($"password:{p.Id}"),
            // A server older than the strength check sends no score: the column then stays empty.
            strength >= 0 ? StrengthWords[strength] : "",
            "neutral",
            warning,
            strength,
            when,
            tone,
            what,
            changed,
            by);
        var subtitle = Join(p.Username.Length > 0 ? p.Username : "No username", host, p.FolderName, p.HasTotp ? "2FA" : null, warning, when.Length > 0 ? $"{what} {when}" : null);
        return new Row("password", p.Id, p.Name, subtitle, p.ClientId, p.ClientName) { Item = facts };
    }

    private Row AssetRow(AssetSummary a)
    {
        var keys = KeyFacts(a);
        var line = Join([a.LayoutName, .. keys.Where(f => f.Kind is "ip" or "os" or "serial" or "model").Take(3).Select(f => f.Value)]);
        var (when, tone, what) = DueFor("asset", a.Id);
        var (changed, by) = Changed(a.UpdatedAt, a.UpdatedByName);
        var status = a.Status switch { "active" => "Active", "inactive" => "Inactive", "retired" => "Retired", var s => s };
        var seen = keys.FirstOrDefault(f => f.Kind == "seen").Value;
        var layoutPlace = layouts.Values.OrderBy(l => l.Name, StringComparer.CurrentCultureIgnoreCase).Select(l => l.Id).ToList().IndexOf(a.LayoutId);
        var facts = new ItemFacts(
            LayoutGlyph(a.LayoutId, a.LayoutName),
            Tile(layoutPlace < 0 ? 0 : layoutPlace + 3),
            line,
            "",
            "",
            starred.Contains($"asset:{a.Id}"),
            status,
            a.Status == "active" ? "good" : "neutral",
            "",
            -1,
            when,
            tone,
            what.Length > 0 ? what : seen is { Length: > 0 } ? $"Seen {seen}" : "",
            changed,
            by);
        return new Row("asset", a.Id, a.Name, Join(line, status, when.Length > 0 ? $"{what} {when}" : null), a.ClientId, a.ClientName) { Item = facts };
    }

    private Row DocumentRow(DocumentSummary d)
    {
        var (when, tone, what) = DueFor("document", d.Id);
        if (when.Length == 0 && d.ReviewDate is { } review && DateTime.TryParse(review, CultureInfo.InvariantCulture, DateTimeStyles.None, out var on))
            (when, tone, what) = ($"Review {on:MMM d}", "neutral", "Review date");
        var (changed, by) = Changed(d.UpdatedAt, d.UpdatedByName);
        var (status, statusTone) = d.Status switch
        {
            "current" => ("Current", "good"),
            "needs_review" => ("Needs review", "caution"),
            "draft" => ("Draft", "neutral"),
            var s => (s, "neutral"),
        };
        var where = d.ClientName ?? "Knowledge base";
        var facts = new ItemFacts(
            "",
            Tile(statusTone switch { "good" => 1, "caution" => 4, _ => 7 }),
            where,
            "",
            "",
            starred.Contains($"document:{d.Id}"),
            status,
            statusTone,
            "",
            -1,
            when,
            tone,
            what,
            changed,
            by);
        return new Row("document", d.Id, d.Title, Join(where, status, when.Length > 0 ? $"{what} {when}" : null), d.ClientId, where) { Item = facts };
    }

    private static readonly string[] CategoryOrder = ["domain", "cloud", "email", "network", "wifi", "server", "database", "remote", "application", "vendor", "website", "device", "other"];

    // An icon for what the login is for; a key when Atlas doesn't say.
    private static string CategoryGlyph(string category, string kind) => kind == "note" ? "" : category switch
    {
        "cloud" => "",
        "email" => "",
        "network" => "",
        "wifi" => "",
        "remote" => "",
        "website" => "",
        "device" => "",
        "domain" => "",
        _ => "",
    };

    private string LayoutGlyph(string layoutId, string layoutName)
    {
        var icon = layouts.TryGetValue(layoutId, out var layout) ? layout.Icon : "";
        var name = $"{icon} {layoutName}".ToLowerInvariant();
        return name.Contains("globe", StringComparison.Ordinal) || name.Contains("domain", StringComparison.Ordinal) ? ""
            : name.Contains("cert", StringComparison.Ordinal) || name.Contains("ssl", StringComparison.Ordinal) ? ""
            : name.Contains("network", StringComparison.Ordinal) || name.Contains("wifi", StringComparison.Ordinal) ? ""
            : name.Contains("print", StringComparison.Ordinal) ? ""
            : name.Contains("licen", StringComparison.Ordinal) ? ""
            : "";
    }

    /// <summary>Column names over the list, for the kind of thing it shows.</summary>
    private void ShowItemHeader(string? kind)
    {
        ItemHeader.Visibility = kind is "passwords" or "assets" or "documents" ? Visibility.Visible : Visibility.Collapsed;
        ItemHeaderName.Text = kind == "documents" ? "Title" : "Name";
        ItemHeaderState.Text = kind == "passwords" ? "Strength" : "Status";
        ItemHeaderDue.Text = kind == "documents" ? "Review" : "Due";
    }

    // ---------- the Clients page ----------
    private List<Row> clientCache = [];
    private string clientTotals = "";

    private static readonly string[] TileColors =
    [
        "#2F6FB2", "#3E8E7E", "#8A5BB5", "#C0573E", "#B8862B", "#4F7A2E", "#B04A7A", "#4B5D8F", "#0F7B8A", "#7A5230", "#5E60CE", "#A23B3B",
    ];

    /// <summary>
    /// Every client with how much is documented for it and what's coming due. The counts come from the lists Atlas
    /// already gives the app; one it won't give (no access to passwords, say) shows as a dash instead of a number.
    /// </summary>
    private async Task<List<Row>> LoadClientRowsAsync(AtlasClient client, CancellationToken cancel)
    {
        static async Task<IReadOnlyList<T>?> Maybe<T>(Task<IReadOnlyList<T>> task)
        {
            try
            {
                return await task;
            }
            catch (AtlasApiException)
            {
                return null;
            }
        }
        var listTask = client.ListClientsAsync(cancel);
        var passwordsTask = Maybe(client.ListPasswordsAsync(null, cancel));
        var assetsTask = Maybe(client.ListAssetsAsync(null, cancel));
        var documentsTask = Maybe(client.ListDocumentsAsync(null, cancel));
        var dueTask = Maybe(client.GetExpirationsAsync(30, cancel));
        await Task.WhenAll(listTask, passwordsTask, assetsTask, documentsTask, dueTask);
        var list = listTask.Result;
        clients = [.. list.Where(c => c.Status != "inactive").Select(c => new ClientChoice(c.Id, c.Name))];

        static Dictionary<string, int>? CountBy<T>(IReadOnlyList<T>? items, Func<T, string?> key) =>
            items?.Where(i => key(i) is not null).GroupBy(i => key(i)!).ToDictionary(g => g.Key, g => g.Count());
        var passwords = CountBy(passwordsTask.Result, p => p.ClientId);
        var assets = CountBy(assetsTask.Result, a => a.ClientId);
        var documents = CountBy(documentsTask.Result, d => d.ClientId);
        var due = dueTask.Result ?? [];
        int? CountFor(Dictionary<string, int>? counts, string id) => counts is null ? null : counts.GetValueOrDefault(id);

        var totals = new List<string> { $"{list.Count:N0} client{(list.Count == 1 ? "" : "s")}" };
        if (passwordsTask.Result is { } p)
            totals.Add($"{p.Count:N0} passwords");
        if (assetsTask.Result is { } a)
            totals.Add($"{a.Count:N0} assets");
        if (documentsTask.Result is { } d)
            totals.Add($"{d.Count(x => x.ClientId is not null):N0} documents");
        if (due.Count > 0)
            totals.Add($"{due.Count(x => x.ClientId is not null || x.ClientName is not null):N0} due in 30 days");
        clientTotals = string.Join(" · ", totals);

        var places = list
            .OrderBy(c => c.Name, StringComparer.CurrentCultureIgnoreCase)
            .Select((c, i) => (c.Id, i))
            .ToDictionary(p => p.Id, p => p.i);
        return [.. list.Select(c =>
        {
            var mine = due.Where(x => x.ClientId == c.Id || (x.ClientId is null && x.ClientName == c.Name)).ToList();
            var note = c.Notes.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault() ?? "";
            var line = Join(
                c.Type,
                ShortAccess(c.Access),
                c.MaintenanceWindow.Length > 0 ? $"Maintenance {c.MaintenanceWindow}" : null,
                c.UpdatedAt is { } at ? $"Updated {Ago(at)}" : null);
            var facts = new ClientFacts(
                Initials(c.Name),
                Tile(places[c.Id]),
                line,
                note,
                c.Status == "active" ? "" : CultureInfo.CurrentCulture.TextInfo.ToTitleCase(c.Status),
                CountFor(passwords, c.Id),
                CountFor(assets, c.Id),
                CountFor(documents, c.Id),
                mine.Count(x => x.DaysLeft >= 0),
                mine.Count(x => x.DaysLeft < 0),
                starred.Contains($"client:{c.Id}"));
            // The subtitle is what the filter box searches and what a screen reader says after the name.
            var subtitle = Join(c.Type, c.Status == "active" ? null : c.Status, note,
                facts.Passwords is { } pw ? $"{pw} passwords" : null,
                facts.Assets is { } asset ? $"{asset} assets" : null,
                facts.Documents is { } doc ? $"{doc} documents" : null,
                mine.Count > 0 ? facts.Attention : null);
            return new Row("client", c.Id, c.Name, subtitle, c.Id, c.Name) { Facts = facts };
        })];
    }

    private void FillStatuses()
    {
        var previous = (TypeFilter.SelectedItem as TypeChoice)?.LayoutId;
        var counts = clientCache.GroupBy(r => r.Facts!.Status.Length == 0 ? "active" : r.Facts.Status.ToLowerInvariant()).ToDictionary(g => g.Key, g => g.Count());
        var choices = new List<TypeChoice> { new(null, $"All clients ({clientCache.Count})") };
        foreach (var (value, label) in new[] { ("active", "Active"), ("prospect", "Prospects"), ("inactive", "Inactive") })
            if (counts.TryGetValue(value, out var n))
                choices.Add(new TypeChoice(value, $"{label} ({n})"));
        fillingTypes = true;
        TypeFilter.ItemsSource = choices;
        TypeFilter.SelectedItem = choices.FirstOrDefault(c => c.LayoutId == previous) ?? choices[0];
        fillingTypes = false;
    }

    private List<Row> ClientRows()
    {
        var status = (TypeFilter.SelectedItem as TypeChoice)?.LayoutId;
        return [.. clientCache.Where(r => status is null || (r.Facts!.Status.Length == 0 ? "active" : r.Facts.Status.ToLowerInvariant()) == status)];
    }

    // The access level in a word or two, for the list.
    private static string ShortAccess(string level) => level switch
    {
        "edit_passwords" => "Full access",
        "edit" => "Can edit",
        "read" => "Read only",
        _ => "",
    };

    // Colours go round in A–Z order, so clients next to each other in the list never share one.
    private static Brush Tile(int place)
    {
        var hex = TileColors[place % TileColors.Length];
        return new SolidColorBrush(Microsoft.UI.ColorHelper.FromArgb(
            255,
            Convert.ToByte(hex[1..3], 16),
            Convert.ToByte(hex[3..5], 16),
            Convert.ToByte(hex[5..7], 16)));
    }

    private static string Ago(string iso)
    {
        if (!DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.None, out var at))
            return "";
        var span = DateTimeOffset.Now - at;
        return span.TotalMinutes < 2 ? "just now"
            : span.TotalHours < 1 ? $"{(int)span.TotalMinutes} minutes ago"
            : span.TotalDays < 1 ? $"{(int)span.TotalHours} hour{((int)span.TotalHours == 1 ? "" : "s")} ago"
            : span.TotalDays < 2 ? "yesterday"
            : span.TotalDays < 60 ? $"{(int)span.TotalDays} days ago"
            : at.ToLocalTime().ToString("MMM d, yyyy", CultureInfo.CurrentCulture);
    }

    /// <summary>
    /// The facts that tell one asset from another, picked by what each field is called: its address, name on the
    /// network, operating system, serial number, model, maker, warranty, last check-in, protection, and user.
    /// </summary>
    private List<(string Kind, string Label, string Value)> KeyFacts(AssetSummary asset)
    {
        layouts.TryGetValue(asset.LayoutId, out var layout);
        var fields = (layout?.Fields ?? []).ToList();
        foreach (var key in asset.Fields.Keys)
            if (!fields.Any(f => f.Key == key))
                fields.Add(new LayoutField(key, Tidy(key), "text"));
        var facts = new List<(string Kind, string Label, string Value)>();
        foreach (var (kind, pattern) in FactKinds)
        {
            foreach (var field in fields)
            {
                var matches = (kind == "ip" && field.Type == "ip") ||
                    System.Text.RegularExpressions.Regex.IsMatch($"{field.Key} {field.Label}", pattern, System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                if (!matches || facts.Any(f => f.Label == Tidy(field.Label)))
                    continue;
                if (asset.Fields.TryGetValue(field.Key, out var value) && Display(value) is { Length: > 0 } text)
                {
                    facts.Add((kind, Tidy(field.Label), field.Type == "date" ? Day(text) : text));
                    break;
                }
            }
        }
        return facts;
    }

    private static readonly (string Kind, string Pattern)[] FactKinds =
    [
        ("ip", @"\bip\b|ip.?address"),
        ("host", @"host.?name|\bfqdn\b"),
        ("os", @"operating.?system|\bos\b"),
        ("serial", @"serial"),
        ("model", @"\bmodel\b"),
        ("maker", @"manufacturer|vendor"),
        ("warranty", @"warranty"),
        ("seen", @"last.?(check|seen|contact)|check.?in"),
        ("protection", @"endpoint.?protection|anti.?virus"),
        ("user", @"logged.?in|last.?user"),
    ];

    // Labels from synced devices ("anti_viruses_application_name") read as words.
    private static string Tidy(string label)
    {
        var words = label.Replace('_', ' ').Trim();
        return words.Length == 0 ? label : char.ToUpperInvariant(words[0]) + words[1..];
    }

    private static string Day(string iso) =>
        DateTimeOffset.TryParse(iso, out var at) ? at.ToLocalTime().ToString("MMM d, yyyy") : iso;

    // What search matched besides the name (an address, a serial number), so same-named results differ.
    private static string? Snippet(string snippet, string title)
    {
        var text = string.Join(' ', snippet.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)).Trim();
        if (text.StartsWith(title, StringComparison.OrdinalIgnoreCase))
            text = text[title.Length..].TrimStart(' ', '—', '-', '·');
        return text.Length > 0 ? text : null;
    }

    private static string Join(params string?[] parts) => string.Join(" · ", parts.Where(p => !string.IsNullOrWhiteSpace(p)));

    // ---------- search ----------
    private async void QueryBox_TextChanged(object sender, TextChangedEventArgs e)
    {
        var query = QueryBox.Text.Trim();
        if (query.Length == 0)
        {
            if (trail.LastOrDefault()?.Kind == "search")
                Back();
            return;
        }
        listCancel?.Cancel();
        try
        {
            // Wait for a pause in typing.
            await Task.Delay(200);
            if (QueryBox.Text.Trim() != query)
                return;
            Go(new Place("search", $"Search: {query}", Query: query));
        }
        catch (OperationCanceledException)
        {
        }
    }

    private void QueryBox_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Down && Results.Items.Count > 0)
        {
            e.Handled = true;
            Results.Focus(FocusState.Keyboard);
        }
    }

    private void Remember(Row row)
    {
        recent.RemoveAll(r => r.Kind == row.Kind && r.Id == row.Id);
        recent.Insert(0, row);
        if (recent.Count > 25)
            recent.RemoveAt(recent.Count - 1);
    }

    // ---------- the item ----------
    private async void ShowItem(Row? row)
    {
        detailCancel?.Cancel();
        var cancel = detailCancel = new CancellationTokenSource();
        HideSecrets();
        password = null;
        ClearDetail();
        current = null;
        if (row is null || app.Client is not { } client)
            return;
        DetailScroll.ChangeView(null, 0, null, true);
        current = row;
        Detail.Children.Add(HeaderCard(row));
        try
        {
            switch (row.Kind)
            {
                case "password":
                    var entry = await client.GetPasswordAsync(row.Id, cancel.Token);
                    if (cancel.IsCancellationRequested)
                        return;
                    password = entry;
                    ShowPassword(entry);
                    break;
                case "asset":
                    var asset = await client.GetAssetAsync(row.Id, cancel.Token);
                    if (layouts.Count == 0)
                        foreach (var layout in await client.ListLayoutsAsync(cancel.Token))
                            layouts[layout.Id] = layout;
                    if (cancel.IsCancellationRequested)
                        return;
                    ShowAsset(asset);
                    break;
                case "document":
                    var document = await client.GetDocumentAsync(row.Id, cancel.Token);
                    if (cancel.IsCancellationRequested)
                        return;
                    ShowDocument(document);
                    break;
                case "client":
                    Detail.Children.Add(Card("Client", Text("Open the client in Atlas, or choose it in the sidebar to list its passwords, assets, and documents.")));
                    break;
                default:
                    if (row.Subtitle.Length > 0)
                        Detail.Children.Add(Card("Details", Text(row.Subtitle)));
                    break;
            }
            Remember(row);
            await ShowExtrasAsync(row, client, cancel.Token);
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex) when (ex is AtlasApiException or HttpRequestException)
        {
            Fail(ex);
        }
    }

    private static string Kind(string kind) => kind switch
    {
        "client" => "Client",
        "asset" => "Asset",
        "document" => "Document",
        "password" => "Password",
        "contact" => "Contact",
        "location" => "Location",
        _ => kind,
    };

    private void ShowPassword(PasswordEntry entry)
    {
        var rows = new List<UIElement>();
        if (entry.Username.Length > 0)
            rows.Add(Field("Username", Value(entry.Username, mono: true), IconButton("", "Copy username (Ctrl+U)", (_, _) => CopyUsername())));
        const string maskedPassword = "••••••••••••";
        var secret = Value(maskedPassword, mono: true);
        rows.Add(Field(
            "Password",
            secret,
            IconButton("", "Show for 30 seconds", (_, _) => _ = ShowSecretAsync(SecretField.Password, secret, maskedPassword)),
            IconButton("", "Copy password (Ctrl+P)", (_, _) => _ = CopySecretAsync(SecretField.Password))));
        if (entry.HasTotp)
        {
            const string maskedCode = "••• •••";
            var code = Value(maskedCode, mono: true);
            rows.Add(Field(
                "One-time code",
                code,
                IconButton("", "Show the current code", (_, _) => _ = ShowSecretAsync(SecretField.OneTimeCode, code, maskedCode)),
                IconButton("", "Copy one-time code (Ctrl+T)", (_, _) => _ = CopySecretAsync(SecretField.OneTimeCode))));
        }
        Detail.Children.Add(Card("Sign-in", [.. rows]));

        if (entry.Url.Length > 0)
        {
            var actions = new List<Button> { IconButton("", "Copy address", (_, _) => Copy(entry.Url, "Address copied.")) };
            if (IsWebAddress(entry.Url))
                actions.Insert(0, IconButton("", "Open the sign-in page", (_, _) => _ = Launcher.LaunchUriAsync(new Uri(entry.Url))));
            Detail.Children.Add(Card("Website", Field("Address", Value(entry.Url), [.. actions])));
        }

        var about = new List<UIElement> { Field("Client", Value(entry.ClientName)) };
        if (entry.RequireReason)
            about.Add(Field("Reason", Value("This client asks for a reason before a password is shown or copied.")));
        about.Add(Field("Updated", Value(When(entry.UpdatedAt))));
        AddSide(Card("About", [.. about]));
        Detail.Children.Add(Footnote("Every time a password is shown or copied, Atlas records it in the password's access history."));
    }

    private void ShowAsset(AssetSummary asset)
    {
        ShowConnect(asset);
        var facts = KeyFacts(asset);
        if (facts.Count > 0)
            Detail.Children.Add(Facts([.. facts.Take(6).Select(f => (f.Label, f.Value))]));

        var rows = new List<UIElement>();
        layouts.TryGetValue(asset.LayoutId, out var layout);
        var known = new HashSet<string>();
        foreach (var field in layout?.Fields ?? [])
        {
            known.Add(field.Key);
            if (asset.Fields.TryGetValue(field.Key, out var value) && Display(value) is { Length: > 0 } text)
                rows.Add(CopyableField(Tidy(field.Label), field.Type == "date" ? Day(text) : text, mono: field.Type is "ip" or "url"));
        }
        // Values a layout no longer lists (an import, say) are still shown.
        foreach (var (key, value) in asset.Fields)
            if (!known.Contains(key) && Display(value) is { Length: > 0 } text)
                rows.Add(CopyableField(Tidy(key), text));
        if (rows.Count == 0)
            Detail.Children.Add(Card("Details", Text("No details filled in yet.")));
        else if (facts.Count == 0 || rows.Count <= 6)
            Detail.Children.Add(Card("Details", [.. rows]));
        else
        {
            var all = new StackPanel();
            for (var i = 0; i < rows.Count; i++)
            {
                if (i > 0)
                    all.Children.Add(new Border { Height = 1, Background = (Brush)Application.Current.Resources["DividerStrokeColorDefaultBrush"] });
                all.Children.Add(rows[i]);
            }
            Detail.Children.Add(new Expander
            {
                Header = $"All fields ({rows.Count})",
                Content = all,
                HorizontalAlignment = HorizontalAlignment.Stretch,
                HorizontalContentAlignment = HorizontalAlignment.Stretch,
                Padding = new Thickness(0),
                Margin = new Thickness(0, 16, 0, 0),
            });
        }
        if (asset.Notes.Trim().Length > 0)
            Detail.Children.Add(Card("Notes", Text(asset.Notes.Trim(), selectable: true)));
        AddSide(Card(
            "About",
            Field("Client", Value(asset.ClientName)),
            Field("Type", Value(asset.LayoutName)),
            Field("Updated", Value(Join(When(asset.UpdatedAt), asset.UpdatedByName)))));
    }

    /// <summary>The key facts as tiles across the top, two to a row; selecting one copies it.</summary>
    private UIElement Facts(List<(string Label, string Value)> facts)
    {
        var grid = new Grid { ColumnSpacing = 8, RowSpacing = 8, Margin = new Thickness(0, 16, 0, 0) };
        const int columns = 2;
        for (var c = 0; c < columns; c++)
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        for (var i = 0; i < facts.Count; i++)
        {
            if (i % columns == 0)
                grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var (label, value) = facts[i];
            var content = new StackPanel { Spacing = 2 };
            content.Children.Add(new TextBlock { Text = label, FontSize = 12, Foreground = Secondary(), TextTrimming = TextTrimming.CharacterEllipsis });
            content.Children.Add(new TextBlock { Text = value, TextWrapping = TextWrapping.Wrap, MaxLines = 2, TextTrimming = TextTrimming.CharacterEllipsis, FontWeight = FontWeights.SemiBold });
            var tile = new Button
            {
                Content = content,
                HorizontalAlignment = HorizontalAlignment.Stretch,
                HorizontalContentAlignment = HorizontalAlignment.Left,
                Padding = new Thickness(12, 9, 12, 10),
            };
            ToolTipService.SetToolTip(tile, $"Copy {label.ToLowerInvariant()}");
            AutomationProperties.SetName(tile, $"{label}: {value}. Copy");
            tile.Click += (_, _) => Copy(value, $"{label} copied.");
            Grid.SetRow(tile, i / columns);
            Grid.SetColumn(tile, i % columns);
            grid.Children.Add(tile);
        }
        return grid;
    }

    private void ShowDocument(DocumentDetail document)
    {
        var editable = canWrite && document.CanEdit && current is not { Archived: true } ? Visibility.Visible : Visibility.Collapsed;
        EditHereButton.Visibility = editable;
        ArchiveButton.Visibility = editable;
        Detail.Children.Add(Card("Document", DocumentBody(document.Content, "This document is empty.")));
        AddSide(Card(
            "About",
            Field("Where", Value(document.ClientName ?? "Knowledge base")),
            Field("Updated", Value(Join(When(document.UpdatedAt), document.UpdatedByName)))));
    }

    private static string Display(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString() ?? "",
        JsonValueKind.Number => value.GetRawText(),
        JsonValueKind.True => "Yes",
        JsonValueKind.False => "No",
        JsonValueKind.Array => string.Join(", ", value.EnumerateArray().Select(Display).Where(s => s.Length > 0)),
        _ => "",
    };

    private static string When(string iso) =>
        DateTimeOffset.TryParse(iso, out var at) ? at.ToLocalTime().ToString("MMM d, yyyy, h:mm tt") : iso;

    private static bool IsWebAddress(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp);

    // ---------- the page's layout ----------
    private void ClearDetail()
    {
        Detail.Children.Clear();
        DetailSide.Children.Clear();
        LayOutDetail();
    }

    /// <summary>A card for beside the page's own (About, Related, and the like), or under them in a narrow window.</summary>
    private void AddSide(UIElement card)
    {
        DetailSide.Children.Add(card);
        LayOutDetail();
    }

    private void DetailScroll_SizeChanged(object sender, SizeChangedEventArgs e) => LayOutDetail();

    private void LayOutDetail()
    {
        // Room for a readable page (560) and the side column (300) with a gap between: the side cards move up beside it.
        var wide = DetailSide.Children.Count > 0 && DetailScroll.ActualWidth - 48 >= 884;
        DetailSideColumn.Width = new GridLength(wide ? 324 : 0);
        Grid.SetRow(DetailSide, wide ? 0 : 1);
        Grid.SetColumn(DetailSide, wide ? 1 : 0);
        DetailSide.Margin = new Thickness(wide ? 24 : 0, 0, 0, 0);
    }

    /// <summary>Short fields side by side, two to a row, so a form fills the page rather than running down a narrow column.</summary>
    private static void PairShortFields(Panel form)
    {
        var children = form.Children.ToList();
        form.Children.Clear();
        for (var i = 0; i < children.Count; i++)
        {
            if (!IsShortField(children[i]) || i + 1 >= children.Count || !IsShortField(children[i + 1]))
            {
                form.Children.Add(children[i]);
                continue;
            }
            var row = new Grid { ColumnSpacing = 16 };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            Grid.SetColumn((FrameworkElement)children[i + 1], 1);
            row.Children.Add(children[i]);
            row.Children.Add(children[i + 1]);
            form.Children.Add(row);
            i++;
        }
    }

    private static bool IsShortField(UIElement element) => element switch
    {
        TextBox box => !box.AcceptsReturn,
        ComboBox or NumberBox or CalendarDatePicker => true,
        _ => false,
    };

    // ---------- building the cards ----------
    /// <summary>The first card: what it is, its name, and the client it belongs to.</summary>
    private static UIElement HeaderCard(Row row)
    {
        var grid = new Grid { ColumnSpacing = 14, Padding = new Thickness(16, 14, 16, 14) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var tile = new Border
        {
            Width = 40,
            Height = 40,
            CornerRadius = new CornerRadius(8),
            Background = (Brush)Application.Current.Resources["AccentFillColorDefaultBrush"],
            Child = new FontIcon { Glyph = row.Glyph, FontSize = 18, Foreground = (Brush)Application.Current.Resources["TextOnAccentFillColorPrimaryBrush"] },
        };
        var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Spacing = 3 };
        text.Children.Add(new TextBlock { Text = row.Title, FontSize = 18, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap });
        var where = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        where.Children.Add(new FontIcon { Glyph = "", FontSize = 12, Foreground = Secondary() });
        where.Children.Add(new TextBlock { Text = Join(Kind(row.Kind), row.ClientName), FontSize = 12, Foreground = Secondary(), TextWrapping = TextWrapping.Wrap });
        text.Children.Add(where);
        Grid.SetColumn(text, 1);
        grid.Children.Add(tile);
        grid.Children.Add(text);
        return new Border
        {
            Background = (Brush)Application.Current.Resources["CardBackgroundFillColorDefaultBrush"],
            BorderBrush = (Brush)Application.Current.Resources["CardStrokeColorDefaultBrush"],
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Child = grid,
        };
    }

    private static UIElement Card(string label, params UIElement[] rows)
    {
        var panel = new StackPanel();
        panel.Children.Add(new TextBlock
        {
            Text = label,
            FontSize = 12,
            FontWeight = FontWeights.SemiBold,
            Foreground = Secondary(),
            Margin = new Thickness(2, 20, 0, 8),
        });
        var list = new StackPanel();
        for (var i = 0; i < rows.Length; i++)
        {
            if (i > 0)
                list.Children.Add(new Border { Height = 1, Background = (Brush)Application.Current.Resources["DividerStrokeColorDefaultBrush"] });
            list.Children.Add(rows[i]);
        }
        panel.Children.Add(new Border
        {
            Background = (Brush)Application.Current.Resources["CardBackgroundFillColorDefaultBrush"],
            BorderBrush = (Brush)Application.Current.Resources["CardStrokeColorDefaultBrush"],
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Child = list,
        });
        return panel;
    }

    private static UIElement Field(string label, TextBlock value, params Button[] actions)
    {
        var grid = new Grid { Padding = new Thickness(16, 10, 8, 10), ColumnSpacing = 8 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        text.Children.Add(new TextBlock { Text = label, FontSize = 12, Foreground = (Brush)Application.Current.Resources["AccentTextFillColorPrimaryBrush"] });
        text.Children.Add(value);
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 2, VerticalAlignment = VerticalAlignment.Center };
        foreach (var action in actions)
            buttons.Children.Add(action);
        Grid.SetColumn(buttons, 1);
        grid.Children.Add(text);
        grid.Children.Add(buttons);
        return grid;
    }

    private UIElement CopyableField(string label, string value, bool mono = false) =>
        Field(label, Value(value, mono), IconButton("", $"Copy {label.ToLowerInvariant()}", (_, _) => Copy(value, $"{label} copied.")));

    private static TextBlock Value(string text, bool mono = false) => new()
    {
        Text = text,
        TextWrapping = TextWrapping.Wrap,
        IsTextSelectionEnabled = true,
        Margin = new Thickness(0, 2, 0, 0),
        FontFamily = mono ? new FontFamily("Cascadia Mono, Consolas") : FontFamily.XamlAutoFontFamily,
    };

    private static UIElement Text(string text, bool selectable = false) =>
        new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = selectable, Padding = new Thickness(16, 12, 16, 14), LineHeight = 22 };

    /// <summary>A document drawn the way it looks in Atlas, or a line saying it's empty.</summary>
    private UIElement DocumentBody(JsonElement content, string empty)
    {
        var blocks = DocumentView.Parse(content);
        return DocumentView.IsEmpty(blocks)
            ? Text(empty)
            : new DocumentRenderer(app.Client?.Address.Origin, code => Copy(code, "Code copied.")).Render(blocks);
    }

    private static UIElement Footnote(string text) =>
        new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, FontSize = 12, Foreground = Secondary(), Margin = new Thickness(2, 14, 0, 0) };

    private static Button IconButton(string glyph, string tip, RoutedEventHandler click)
    {
        var button = new Button
        {
            Content = new FontIcon { Glyph = glyph, FontSize = 14 },
            Width = 36,
            Height = 32,
            Padding = new Thickness(0),
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            BorderThickness = new Thickness(0),
        };
        ToolTipService.SetToolTip(button, tip);
        AutomationProperties.SetName(button, tip);
        button.Click += click;
        return button;
    }

    private static Brush Secondary() => (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"];

    // ---------- the bar under the item ----------
    private void Edit_Click(object sender, RoutedEventArgs e)
    {
        if (current is { } row)
            _ = OpenInAtlasAsync(row);
    }

    private void CopyLink_Click(object sender, RoutedEventArgs e)
    {
        if (current is { } row && app.Client is { } client)
            Copy(client.Address.WebLink(row.Kind, row.Id, row.ClientId).ToString(), "Link copied.");
    }

    // ---------- actions ----------
    private Task OpenInAtlasAsync(Row row) =>
        app.Client is { } client ? Launcher.LaunchUriAsync(client.Address.WebLink(row.Kind, row.Id, row.ClientId)).AsTask() : Task.CompletedTask;

    private void Copy(string text, string message)
    {
        clipboard.Copy(text, sensitive: false);
        Show(message, InfoBarSeverity.Success);
    }

    private void CopyUsername()
    {
        if (password is { Username.Length: > 0 })
            Copy(password.Username, "Username copied.");
    }

    /// <summary>
    /// Copies a password or the current one-time code. Atlas records the copy in the password's access history (with
    /// this app and computer named) and asks for a reason where the client requires one.
    /// </summary>
    private async Task CopySecretAsync(SecretField field, string reason = "")
    {
        if (password is not { } entry || app.Client is not { } client)
            return;
        if (field == SecretField.OneTimeCode && !entry.HasTotp)
            return;
        if (reason.Length == 0 && !await SecretCheckAsync($"Copy the {(field == SecretField.OneTimeCode ? "code" : "password")} for {entry.Name}"))
            return;
        try
        {
            var secret = await client.RevealForCopyAsync(entry.Id, field, reason);
            clipboard.Copy(secret.Value, sensitive: true);
            Show(
                field == SecretField.OneTimeCode
                    ? $"Code copied. It changes in {secret.ExpiresIn ?? 30} seconds; the clipboard clears in 30."
                    : "Password copied. The clipboard clears in 30 seconds.",
                InfoBarSeverity.Success);
        }
        catch (AtlasApiException ex) when (ex.Code == "reason_required" && reason.Length == 0)
        {
            if (await AskReasonAsync() is { } given)
                await CopySecretAsync(field, given);
        }
        catch (Exception ex) when (ex is AtlasApiException or HttpRequestException)
        {
            Fail(ex);
        }
    }

    /// <summary>Shows a password or code in place for 30 seconds (a code until it changes), then hides it again.</summary>
    private async Task ShowSecretAsync(SecretField field, TextBlock target, string masked, string reason = "")
    {
        if (password is not { } entry || app.Client is not { } client)
            return;
        if (reason.Length == 0 && !await SecretCheckAsync($"Show the {(field == SecretField.OneTimeCode ? "code" : "password")} for {entry.Name}"))
            return;
        try
        {
            var secret = await client.RevealToShowAsync(entry.Id, field, reason);
            if (!ReferenceEquals(password, entry))
                return;
            HideSecrets();
            var text = field == SecretField.OneTimeCode && secret.Value.Length == 6 ? $"{secret.Value[..3]} {secret.Value[3..]}" : secret.Value;
            shown = (target, masked);
            if (field == SecretField.OneTimeCode)
            {
                // A code shows how long it has left, a second at a time, and goes when it changes.
                var until = DateTimeOffset.UtcNow.AddSeconds(secret.ExpiresIn ?? 30);
                void Tick()
                {
                    var left = (int)Math.Ceiling((until - DateTimeOffset.UtcNow).TotalSeconds);
                    if (left <= 0)
                        HideSecrets();
                    else
                        target.Text = $"{text}   ·  changes in {left}s";
                }
                Tick();
                hideTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
                hideTimer.Tick += (_, _) => Tick();
            }
            else
            {
                target.Text = text;
                hideTimer = new DispatcherTimer { Interval = ShowFor };
                hideTimer.Tick += (_, _) => HideSecrets();
            }
            hideTimer.Start();
        }
        catch (AtlasApiException ex) when (ex.Code == "reason_required" && reason.Length == 0)
        {
            if (await AskReasonAsync() is { } given)
                await ShowSecretAsync(field, target, masked, given);
        }
        catch (Exception ex) when (ex is AtlasApiException or HttpRequestException)
        {
            Fail(ex);
        }
    }

    // Anything shown is taken off the screen when its time is up, the window hides, or another item is chosen.
    private void HideSecrets()
    {
        hideTimer?.Stop();
        hideTimer = null;
        if (shown is { } s)
            s.Target.Text = s.Masked;
        shown = null;
    }

    private async Task<string?> AskReasonAsync()
    {
        var box = new TextBox { PlaceholderText = "For example, ticket 4821", MaxLength = 300 };
        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            Title = "Why do you need this password?",
            Content = new StackPanel
            {
                Spacing = 8,
                Children =
                {
                    new TextBlock { Text = "This client asks for a reason. It's saved with the password's access history.", TextWrapping = TextWrapping.Wrap },
                    box,
                },
            },
            PrimaryButtonText = "Continue",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Primary,
        };
        var answer = await dialog.ShowAsync();
        var reason = box.Text.Trim();
        return answer == ContentDialogResult.Primary && reason.Length > 0 ? reason : null;
    }

    private void Fail(Exception ex)
    {
        if (ex is SessionEndedException)
        {
            app.SessionEnded();
            return;
        }
        Show(ex is HttpRequestException unreachable ? ConnectionProblem.Describe(unreachable) : ex.Message, InfoBarSeverity.Error);
    }

    private void Show(string message, InfoBarSeverity severity)
    {
        StatusBar.Severity = severity;
        StatusBar.Message = message;
        StatusBar.IsOpen = true;
    }
}
