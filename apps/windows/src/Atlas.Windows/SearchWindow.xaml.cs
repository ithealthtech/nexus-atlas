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
/// The Atlas window: a sidebar of what to look at (starred, recent, passwords, assets, documents, and clients), the
/// list, and the chosen item laid out in cards with a copy button beside each value. It is hidden, not closed,
/// between uses, so the hotkey brings it back instantly. Secrets are fetched only to copy or briefly show them;
/// Atlas records each one, and a copied secret is cleared from the clipboard after 30 seconds.
/// </summary>
public sealed partial class SearchWindow : Window
{
    private const int HotkeyId = 0xA71A;
    private static readonly TimeSpan ShowFor = TimeSpan.FromSeconds(30);
    private static readonly Section[] SectionList =
    [
        new("favorites", "Favorites", ""),
        new("recent", "Recent", ""),
        new("passwords", "Passwords", ""),
        new("assets", "Assets", ""),
        new("documents", "Documents", ""),
    ];

    private readonly App app;
    private readonly IntPtr hwnd;
    private readonly Native.SubclassProc subclass;
    private readonly ClipboardGuard clipboard;
    private readonly List<Row> recent = [];
    private readonly Dictionary<string, LayoutInfo> layouts = [];
    private List<ClientChoice> clients = [];
    private CancellationTokenSource? listCancel;
    private CancellationTokenSource? detailCancel;
    private CancellationTokenSource? signInCancel;
    private DispatcherTimer? hideTimer;
    private (TextBlock Target, string Masked)? shown;
    private string section = "favorites";
    private string? clientId;
    private PasswordEntry? password;
    private bool loaded;
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
        var height = Math.Min(760, area.Height - 32);
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
        Accelerator(VirtualKey.Escape, VirtualKeyModifiers.None, () =>
        {
            if (QueryBox.Text.Length > 0)
                QueryBox.Text = "";
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
        SearchPanel.Visibility = Visibility.Collapsed;
        SetupPanel.Visibility = Visibility.Visible;
        TitleOrg.Text = "";
        loaded = false;
        recent.Clear();
        layouts.Clear();
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
        SearchPanel.Visibility = Visibility.Visible;
        Bring();
        if (!loaded)
        {
            loaded = true;
            _ = LoadAccountAsync();
            Sections.SelectedIndex = 0;
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
            AccountInitials.Text = Initials(session.User.Name);
            TitleOrg.Text = session.Organization.Name;
            var list = await client.ListClientsAsync();
            clients = [new ClientChoice(null, "All clients"), .. list.Where(c => c.Status != "inactive").Select(c => new ClientChoice(c.Id, c.Name))];
            ShowClients();
        }
        catch (Exception ex) when (ex is AtlasApiException or HttpRequestException)
        {
            Fail(ex);
        }
    }

    private static string Initials(string name) =>
        string.Concat(name.Split(' ', StringSplitOptions.RemoveEmptyEntries).Take(2).Select(w => char.ToUpperInvariant(w[0])));

    private void ShowClients()
    {
        var filter = ClientFilter.Text.Trim();
        ClientList.SelectionChanged -= ClientList_SelectionChanged;
        ClientList.ItemsSource = clients.Where(c => c.Id is null || c.Name.Contains(filter, StringComparison.OrdinalIgnoreCase)).ToList();
        ClientList.SelectedItem = clients.FirstOrDefault(c => c.Id == clientId);
        ClientList.SelectionChanged += ClientList_SelectionChanged;
    }

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

    // ---------- the sidebar ----------
    private void Sections_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (Sections.SelectedItem is not Section chosen)
            return;
        section = chosen.Id;
        QueryBox.Text = "";
        _ = LoadListAsync();
    }

    private void ClientList_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (ClientList.SelectedItem is not ClientChoice chosen)
            return;
        clientId = chosen.Id;
        QueryBox.Text = "";
        // A client's things are its passwords, assets, and documents; starred and recent span every client.
        if (clientId is not null && section is "favorites" or "recent")
            Sections.SelectedIndex = 2;
        else
            _ = LoadListAsync();
    }

    private void ClientFilter_TextChanged(object sender, TextChangedEventArgs e) => ShowClients();

    private void OpenAtlas_Click(object sender, RoutedEventArgs e)
    {
        if (app.Client is { } client)
            _ = Launcher.LaunchUriAsync(client.Address.Origin);
    }

    private void Refresh_Click(object sender, RoutedEventArgs e)
    {
        layouts.Clear();
        _ = LoadAccountAsync();
        _ = LoadListAsync();
    }

    private void SignOut_Click(object sender, RoutedEventArgs e) => _ = app.SignOutAsync();

    // ---------- the list ----------
    private async Task LoadListAsync()
    {
        if (app.Client is not { } client)
            return;
        listCancel?.Cancel();
        var cancel = listCancel = new CancellationTokenSource();
        var clientName = clients.FirstOrDefault(c => c.Id is not null && c.Id == clientId)?.Name;
        var label = SectionList.First(s => s.Id == section).Label;
        ListTitle.Text = clientName is null || section is "favorites" or "recent" ? label : $"{label} · {clientName}";
        ListLoading.Visibility = Visibility.Visible;
        try
        {
            IReadOnlyList<Row> rows = section switch
            {
                "favorites" => (await client.ListFavoritesAsync(cancel.Token))
                    .Where(f => f.Type is "password" or "asset" or "document" or "client")
                    .Select(f => new Row(f.Type, f.Id, f.Name, f.ClientName ?? (f.Type == "client" ? "Client" : "Knowledge base"), f.ClientId, f.ClientName))
                    .ToList(),
                "recent" => [.. recent],
                "passwords" => (await client.ListPasswordsAsync(clientId, cancel.Token))
                    .OrderBy(p => p.Name, StringComparer.CurrentCultureIgnoreCase)
                    .Select(p => new Row("password", p.Id, p.Name, Join(p.Username, clientId is null ? p.ClientName : null), p.ClientId, p.ClientName))
                    .ToList(),
                "assets" => (await client.ListAssetsAsync(clientId, cancel.Token))
                    .OrderBy(a => a.Name, StringComparer.CurrentCultureIgnoreCase)
                    .Select(a => new Row("asset", a.Id, a.Name, Join(a.LayoutName, clientId is null ? a.ClientName : null), a.ClientId, a.ClientName))
                    .ToList(),
                "documents" => (await client.ListDocumentsAsync(clientId, cancel.Token))
                    .OrderBy(d => d.Title, StringComparer.CurrentCultureIgnoreCase)
                    .Select(d => new Row("document", d.Id, d.Title, d.ClientName ?? "Knowledge base", d.ClientId, d.ClientName))
                    .ToList(),
                _ => [],
            };
            if (cancel.IsCancellationRequested)
                return;
            ShowRows(rows, section switch
            {
                "favorites" => "Nothing starred yet. Star clients, assets, documents, and passwords in Atlas to keep them here.",
                "recent" => "What you open here shows up in this list.",
                _ => clientName is null ? "Nothing here yet." : $"{clientName} has nothing here yet.",
            });
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

    private void ShowRows(IReadOnlyList<Row> rows, string emptyText)
    {
        Results.ItemsSource = rows;
        ListCount.Text = rows.Count == 0 ? "" : rows.Count.ToString();
        ListEmpty.Visibility = rows.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        ListEmptyText.Text = emptyText;
        if (rows.Count > 0)
            Results.SelectedIndex = 0;
        else
            ShowItem(null);
    }

    private static string Join(params string?[] parts) => string.Join(" · ", parts.Where(p => !string.IsNullOrWhiteSpace(p)));

    private async void QueryBox_TextChanged(object sender, TextChangedEventArgs e)
    {
        var query = QueryBox.Text.Trim();
        if (query.Length == 0)
        {
            _ = LoadListAsync();
            return;
        }
        if (app.Client is not { } client)
            return;
        listCancel?.Cancel();
        var cancel = listCancel = new CancellationTokenSource();
        try
        {
            // Wait for a pause in typing.
            await Task.Delay(150, cancel.Token);
            ListTitle.Text = $"Results for “{query}”";
            ListLoading.Visibility = Visibility.Visible;
            var results = await client.SearchAsync(query, 30, cancel.Token);
            if (cancel.IsCancellationRequested)
                return;
            ShowRows(
                results.Select(r => new Row(r.Type, r.Id, r.Title, Join(r.Subtitle, r.ClientName == r.Subtitle ? null : r.ClientName), r.ClientId, r.ClientName)).ToList(),
                "Nothing you can see matches that.");
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

    private void QueryBox_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Down && Results.Items.Count > 0)
        {
            e.Handled = true;
            Results.Focus(FocusState.Keyboard);
        }
        else if (e.Key == VirtualKey.Enter && Results.SelectedItem is Row row)
        {
            e.Handled = true;
            _ = RunDefaultAsync(row);
        }
    }

    private void Results_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Enter && Results.SelectedItem is Row row)
        {
            e.Handled = true;
            _ = RunDefaultAsync(row);
        }
    }

    private void Results_DoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
    {
        if (Results.SelectedItem is Row row)
            _ = RunDefaultAsync(row);
    }

    /// <summary>Enter copies a password entry's password, and opens anything else in Atlas.</summary>
    private Task RunDefaultAsync(Row row) =>
        row.Kind == "password" ? CopySecretAsync(SecretField.Password) : OpenInAtlasAsync(row);

    private void Results_SelectionChanged(object sender, SelectionChangedEventArgs e) => ShowItem(Results.SelectedItem as Row);

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
        DetailEmpty.Visibility = row is null ? Visibility.Visible : Visibility.Collapsed;
        if (row is null || app.Client is not { } client)
            return;
        DetailScroll.ChangeView(null, 0, null, true);
        Detail.Children.Add(Header(row, Join(Kind(row.Kind), row.ClientName)));
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
        var rows = new List<UIElement>();
        layouts.TryGetValue(asset.LayoutId, out var layout);
        var known = new HashSet<string>();
        foreach (var field in layout?.Fields ?? [])
        {
            known.Add(field.Key);
            if (asset.Fields.TryGetValue(field.Key, out var value) && Display(value) is { Length: > 0 } text)
                rows.Add(CopyableField(field.Label, text, mono: field.Type is "ip" or "url"));
        }
        // Values a layout no longer lists (an import, say) are still shown.
        foreach (var (key, value) in asset.Fields)
            if (!known.Contains(key) && Display(value) is { Length: > 0 } text)
                rows.Add(CopyableField(key, text));
        Detail.Children.Add(rows.Count > 0 ? Card("Details", [.. rows]) : Card("Details", Text("No details filled in yet.")));
        if (asset.Notes.Trim().Length > 0)
            Detail.Children.Add(Card("Notes", Text(asset.Notes.Trim(), selectable: true)));
        Detail.Children.Add(Card(
            "About",
            Field("Client", Value(asset.ClientName)),
            Field("Layout", Value(asset.LayoutName)),
            Field("Status", Value(asset.Status.Length > 0 ? char.ToUpperInvariant(asset.Status[0]) + asset.Status[1..] : "")),
            Field("Updated", Value(Join(When(asset.UpdatedAt), asset.UpdatedByName)))));
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
    private UIElement Header(Row row, string subtitle)
    {
        var grid = new Grid { ColumnSpacing = 14, Margin = new Thickness(0, 0, 0, 6) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var tile = new Border
        {
            Width = 44,
            Height = 44,
            CornerRadius = new CornerRadius(10),
            Background = (Brush)Root.Resources["AccentTileBrush"],
            Child = new FontIcon { Glyph = row.Glyph, FontSize = 20, Foreground = new SolidColorBrush(Microsoft.UI.Colors.White) },
        };
        var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        text.Children.Add(new TextBlock { Text = row.Title, Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"], TextWrapping = TextWrapping.Wrap });
        text.Children.Add(new TextBlock { Text = subtitle, Foreground = Secondary(), Margin = new Thickness(0, 2, 0, 0), TextWrapping = TextWrapping.Wrap });
        var open = new Button { Content = "Open in Atlas", VerticalAlignment = VerticalAlignment.Center };
        open.Click += (_, _) => _ = OpenInAtlasAsync(row);
        Grid.SetColumn(text, 1);
        Grid.SetColumn(open, 2);
        grid.Children.Add(tile);
        grid.Children.Add(text);
        grid.Children.Add(open);
        return grid;
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
        text.Children.Add(new TextBlock { Text = label, FontSize = 12, Foreground = Secondary() });
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
