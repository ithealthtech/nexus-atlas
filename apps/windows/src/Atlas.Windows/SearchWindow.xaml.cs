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
    private sealed record Place(string Kind, string Title, string? ClientId = null, string Tab = "passwords", Row? Item = null, string? Query = null);

    private readonly App app;
    private readonly IntPtr hwnd;
    private readonly Native.SubclassProc subclass;
    private readonly ClipboardGuard clipboard;
    private readonly List<Row> recent = [];
    private readonly Dictionary<string, LayoutInfo> layouts = [];
    private readonly List<Place> trail = [];
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
            ToolTipService.SetToolTip(AccountButton, $"{session.User.Name} · {session.User.Email}");
            AccountInitials.Text = Initials(session.User.Name);
            AppTitleBar.Subtitle = session.Organization.Name;
            foreach (var layout in await client.ListLayoutsAsync())
                layouts[layout.Id] = layout;
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
        FilterBox.Text = "";
        _ = LoadPageAsync();
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
        ListPanel.Visibility = isItem ? Visibility.Collapsed : Visibility.Visible;
        DetailScroll.Visibility = isItem ? Visibility.Visible : Visibility.Collapsed;
        DetailBar.Visibility = isItem ? Visibility.Visible : Visibility.Collapsed;
        FilterBox.Visibility = isItem || place.Kind == "search" ? Visibility.Collapsed : Visibility.Visible;
        TypeFilter.Visibility = Visibility.Collapsed;
        Tabs.Visibility = place.Kind == "client" ? Visibility.Visible : Visibility.Collapsed;
        PageTitle.Text = place.Title;
        PageInfo.Text = "";
        if (isItem)
        {
            PageInfo.Text = Join(Kind(place.Item!.Kind), place.Item.ClientName);
            ShowItem(place.Item);
            return;
        }
        if (place.Kind == "client")
        {
            switchingTabs = true;
            Tabs.SelectedItem = place.Tab switch { "assets" => AssetsTab, "documents" => DocumentsTab, _ => PasswordsTab };
            switchingTabs = false;
        }
        FilterBox.Text = "";
        _ = LoadPageAsync();
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
                        rows.AddRange((await client.ListFavoritesAsync(cancel.Token))
                            .Where(f => f.Type is "password" or "asset" or "document" or "client")
                            .Select(f => new Row(f.Type, f.Id, f.Name, Join(Kind(f.Type), f.ClientName), f.ClientId, "Favorites")));
                    }
                    catch (AtlasApiException ex) when (ex.Code == "api_scope")
                    {
                        // An Atlas older than this app doesn't share favorites with it yet.
                    }
                    rows.AddRange(recent.Select(r => r with { ClientName = "Recently opened", Subtitle = Join(Kind(r.Kind), r.ClientName) }));
                    groupBy = r => r.ClientName!;
                    empty = "Star things in Atlas to keep them here. What you open shows up here too.";
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
