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
    private sealed record Place(string Kind, string Title, string? ClientId = null, string Tab = "overview", Row? Item = null, string? Query = null);

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
        AppWindow.Show();
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
        NewButton.Visibility = canWrite && showsPasswords ? Visibility.Visible : Visibility.Collapsed;
        var editable = canWrite && place.Item is { Kind: "password" };
        EditHereButton.Visibility = editable ? Visibility.Visible : Visibility.Collapsed;
        ArchiveButton.Visibility = editable ? Visibility.Visible : Visibility.Collapsed;
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
        Go(new Place("edit", "New password", ClientId: place?.Kind == "client" ? place.ClientId : null));
    }

    private void EditHere_Click(object sender, RoutedEventArgs e)
    {
        if (current is { Kind: "password" } row)
            Go(new Place("edit", $"Edit {row.Title}", ClientId: row.ClientId, Item: row));
    }

    private async void Archive_Click(object sender, RoutedEventArgs e)
    {
        if (current is not { Kind: "password" } row || app.Client is not { } client)
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
        Detail.Children.Clear();
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

        var form = new StackPanel { Spacing = 14, MaxWidth = 560, HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 8, 0, 24) };
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
        var cancelButton = new Button { Content = "Cancel" };
        cancelButton.Click += (_, _) => Back();
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 6, 0, 0) };
        buttons.Children.Add(save);
        buttons.Children.Add(cancelButton);
        foreach (var control in new UIElement[] { name, username, secretRow, url, totp, removeTotp, folder, rotation, notes, error, buttons })
            form.Children.Add(control);
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
                Show(existing is null ? $"{row.Title} added." : "Changes saved. The previous password is in the entry's history.", InfoBarSeverity.Success);
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

    // ---------- a client's overview ----------
    /// <summary>The client at a glance: its quick note, hours, the people and places to know, editable where allowed.</summary>
    private async void ShowOverview(string clientId)
    {
        detailCancel?.Cancel();
        var cancel = detailCancel = new CancellationTokenSource();
        HideSecrets();
        password = null;
        current = null;
        Detail.Children.Clear();
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

            if (contacts.Count > 0)
                Detail.Children.Add(Card("Contacts", [.. contacts.Select(ContactRow)]));
            if (locations.Count > 0)
                Detail.Children.Add(Card("Locations", [.. locations.Select(LocationRow)]));
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

    private UIElement ContactRow(ContactInfo contact)
    {
        var actions = new List<Button>();
        if (contact.Email.Length > 0)
            actions.Add(IconButton("", $"Copy {contact.Email}", (_, _) => Copy(contact.Email, "Email address copied.")));
        var phone = contact.Phone.Length > 0 ? contact.Phone : contact.Mobile;
        if (phone.Length > 0)
            actions.Add(IconButton("", $"Copy {phone}", (_, _) => Copy(phone, "Phone number copied.")));
        var label = contact.Primary ? $"{contact.Name} · primary" : contact.Name;
        return Field(label, Value(Join(contact.Title, contact.Email, phone)), [.. actions]);
    }

    private UIElement LocationRow(LocationInfo location)
    {
        var label = location.Primary ? $"{location.Name} · primary" : location.Name;
        var address = location.OneLine;
        return address.Length > 0
            ? Field(label, Value(Join(address, location.Phone)), IconButton("", "Copy address", (_, _) => Copy(address, "Address copied.")))
            : Field(label, Value(location.Phone));
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
                    rows = [.. clients.Select(c => new Row("client", c.Id!, c.Name, "Client", c.Id, c.Name))];
                    empty = "You don't have access to any clients yet.";
                    break;
                case "passwords":
                    rows = [.. (await client.ListPasswordsAsync(clientId, cancel.Token))
                        .Select(p => new Row("password", p.Id, p.Name, p.Username.Length > 0 ? p.Username : "No username", p.ClientId, p.ClientName))];
                    break;
                case "assets":
                    assetCache = await client.ListAssetsAsync(clientId, cancel.Token);
                    FillTypes();
                    rows = AssetRows();
                    break;
                case "documents":
                    rows = [.. (await client.ListDocumentsAsync(clientId, cancel.Token))
                        .Select(d => new Row("document", d.Id, d.Title, d.ClientName is null ? "Knowledge base" : "Document", d.ClientId, d.ClientName ?? "Knowledge base"))];
                    break;
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
            TypeFilter.Visibility = kind == "assets" ? Visibility.Visible : Visibility.Collapsed;
            loaded = rows;
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
            .Select(a =>
            {
                var facts = KeyFacts(a).Where(f => f.Kind is "ip" or "os" or "seen").Select(f => f.Value);
                return new Row("asset", a.Id, a.Name, Join([a.LayoutName, .. facts]), a.ClientId, a.ClientName);
            })];
    }

    private void TypeFilter_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (fillingTypes || trail.Count == 0)
            return;
        loaded = AssetRows();
        Render();
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
        Detail.Children.Clear();
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
        Detail.Children.Add(Card("About", [.. about]));
        Detail.Children.Add(Footnote("Every time a password is shown or copied, Atlas records it in the password's access history."));
    }

    private void ShowAsset(AssetSummary asset)
    {
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
        Detail.Children.Add(Card(
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
        var text = RichTextPlain.From(document.Content);
        Detail.Children.Add(Card("Document", Text(text.Length > 0 ? text : "This document is empty.", selectable: true)));
        Detail.Children.Add(Card(
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
        try
        {
            var secret = await client.RevealToShowAsync(entry.Id, field, reason);
            if (!ReferenceEquals(password, entry))
                return;
            HideSecrets();
            target.Text = field == SecretField.OneTimeCode && secret.Value.Length == 6 ? $"{secret.Value[..3]} {secret.Value[3..]}" : secret.Value;
            shown = (target, masked);
            hideTimer = new DispatcherTimer { Interval = field == SecretField.OneTimeCode ? TimeSpan.FromSeconds(secret.ExpiresIn ?? 30) : ShowFor };
            hideTimer.Tick += (_, _) => HideSecrets();
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
