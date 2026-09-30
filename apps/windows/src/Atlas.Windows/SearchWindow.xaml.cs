using Atlas.Windows.Core;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Windows.System;
using WinRT.Interop;

namespace Atlas.Windows;

/// <summary>
/// The quick-search window. It is hidden, not closed, between uses, so the hotkey brings it back instantly.
/// Secrets are fetched only when copied, go straight to the clipboard, and are cleared from it after 30 seconds.
/// </summary>
public sealed partial class SearchWindow : Window
{
    private const int HotkeyId = 0xA71A;
    private readonly App app;
    private readonly IntPtr hwnd;
    private readonly Native.SubclassProc subclass;
    private readonly ClipboardGuard clipboard;
    private CancellationTokenSource? searchCancel;
    private CancellationTokenSource? signInCancel;
    private PasswordEntry? password;
    private bool shuttingDown;

    public SearchWindow(App app)
    {
        this.app = app;
        InitializeComponent();
        hwnd = WindowNative.GetWindowHandle(this);
        clipboard = new ClipboardGuard(new Native.Clipboard(hwnd), TimeProvider.System);
        clipboard.Cleared += (_, _) => DispatcherQueue.TryEnqueue(() => Show("Clipboard cleared.", InfoBarSeverity.Informational));

        AppWindow.Resize(new global::Windows.Graphics.SizeInt32(760, 520));
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "Tray.ico"));
        if (AppWindow.Presenter is OverlappedPresenter presenter)
        {
            presenter.IsMaximizable = false;
            presenter.IsMinimizable = false;
        }
        // Closing hides the window; the app keeps running in the tray.
        AppWindow.Closing += (_, e) =>
        {
            if (shuttingDown)
                return;
            e.Cancel = true;
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
        QueryBox.Focus(FocusState.Programmatic);
        QueryBox.SelectAll();
    }

    private void Bring()
    {
        AppWindow.Show();
        Activate();
        Native.SetForegroundWindow(hwnd);
    }

    private void Root_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Escape)
        {
            e.Handled = true;
            AppWindow.Hide();
        }
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
            SetupMessage.Message = ex is HttpRequestException ? "Atlas could not be reached. Check the address and your connection." : ex.Message;
            SetupMessage.IsOpen = true;
        }
        finally
        {
            SignInButton.IsEnabled = true;
            SignInProgress.IsActive = false;
        }
    }

    // ---------- search ----------
    private async void QueryBox_TextChanged(object sender, TextChangedEventArgs e)
    {
        searchCancel?.Cancel();
        var cancel = searchCancel = new CancellationTokenSource();
        var query = QueryBox.Text;
        try
        {
            // Wait for a pause in typing.
            await Task.Delay(150, cancel.Token);
            IReadOnlyList<SearchResult> results = app.Client is null ? [] : await app.Client.SearchAsync(query, 15, cancel.Token);
            if (cancel.IsCancellationRequested)
                return;
            Results.ItemsSource = results;
            if (results.Count > 0)
                Results.SelectedIndex = 0;
            else
                ShowDetail(null);
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex) when (ex is AtlasApiException or HttpRequestException)
        {
            Fail(ex);
        }
    }

    private void QueryBox_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Down && Results.Items.Count > 0)
        {
            e.Handled = true;
            Results.Focus(FocusState.Keyboard);
        }
        else if (e.Key == VirtualKey.Enter && Results.SelectedItem is SearchResult result)
        {
            e.Handled = true;
            _ = RunDefaultAsync(result);
        }
    }

    private void Results_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Enter && Results.SelectedItem is SearchResult result)
        {
            e.Handled = true;
            _ = RunDefaultAsync(result);
        }
    }

    private void Results_DoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
    {
        if (Results.SelectedItem is SearchResult result)
            _ = RunDefaultAsync(result);
    }

    /// <summary>Enter copies a password entry's password, and opens anything else in Atlas.</summary>
    private Task RunDefaultAsync(SearchResult result) =>
        result.IsPassword ? CopySecretAsync(SecretField.Password) : OpenAsync(app.Client!.Address.WebLink(result.Type, result.Id, result.ClientId));

    private async void Results_SelectionChanged(object sender, SelectionChangedEventArgs e) =>
        await ShowDetailAsync(Results.SelectedItem as SearchResult);

    // ---------- the read-only summary ----------
    private async Task ShowDetailAsync(SearchResult? result)
    {
        ShowDetail(result);
        if (result is not { IsPassword: true } || app.Client is null)
            return;
        try
        {
            var entry = await app.Client.GetPasswordAsync(result.Id);
            if (!ReferenceEquals(Results.SelectedItem, result))
                return;
            password = entry;
            DetailBody.Text = string.Join(
                Environment.NewLine,
                new[]
                {
                    entry.Username.Length > 0 ? $"Username: {entry.Username}" : null,
                    entry.Url.Length > 0 ? $"Sign-in address: {entry.Url}" : null,
                    entry.HasTotp ? "Has a one-time code" : null,
                    entry.RequireReason ? "This client asks for a reason before passwords are copied." : null,
                }.Where(line => line is not null));
            CopyUsernameButton.Visibility = VisibleIf(entry.Username.Length > 0);
            OpenSignInButton.Visibility = VisibleIf(IsWebAddress(entry.Url));
            CopyCodeButton.Visibility = VisibleIf(entry.HasTotp);
        }
        catch (Exception ex) when (ex is AtlasApiException or HttpRequestException)
        {
            Fail(ex);
        }
    }

    private void ShowDetail(SearchResult? result)
    {
        password = null;
        Detail.Visibility = VisibleIf(result is not null);
        if (result is null)
            return;
        DetailTitle.Text = result.Title;
        DetailKind.Text = string.Join(" · ", new[] { Label(result.Type), result.ClientName }.Where(s => !string.IsNullOrEmpty(s)));
        DetailBody.Text = string.Join(Environment.NewLine, new[] { result.Subtitle, result.Snippet }.Where(s => !string.IsNullOrEmpty(s)));
        CopyPasswordButton.Visibility = VisibleIf(result.IsPassword);
        CopyCodeButton.Visibility = Visibility.Collapsed;
        CopyUsernameButton.Visibility = Visibility.Collapsed;
        OpenSignInButton.Visibility = Visibility.Collapsed;
    }

    private static string Label(string type) => type switch
    {
        "client" => "Client",
        "asset" => "Asset",
        "document" => "Document",
        "password" => "Password",
        "contact" => "Contact",
        "location" => "Location",
        _ => type,
    };

    private static Visibility VisibleIf(bool visible) => visible ? Visibility.Visible : Visibility.Collapsed;

    private static bool IsWebAddress(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp);

    // ---------- actions ----------
    private void CopyPassword_Click(object sender, RoutedEventArgs e) => _ = CopySecretAsync(SecretField.Password);

    private void CopyCode_Click(object sender, RoutedEventArgs e) => _ = CopySecretAsync(SecretField.OneTimeCode);

    private void CopyUsername_Click(object sender, RoutedEventArgs e)
    {
        if (password is null)
            return;
        clipboard.Copy(password.Username, sensitive: false);
        Show("Username copied.", InfoBarSeverity.Success);
    }

    private void OpenSignIn_Click(object sender, RoutedEventArgs e)
    {
        if (password is not null && IsWebAddress(password.Url))
            _ = OpenAsync(new Uri(password.Url));
    }

    private void OpenWeb_Click(object sender, RoutedEventArgs e)
    {
        if (Results.SelectedItem is SearchResult result && app.Client is not null)
            _ = OpenAsync(app.Client.Address.WebLink(result.Type, result.Id, result.ClientId));
    }

    private async Task OpenAsync(Uri uri)
    {
        await Launcher.LaunchUriAsync(uri);
        AppWindow.Hide();
    }

    /// <summary>
    /// Copies a password or the current one-time code. Atlas records the copy in the password's access history (with
    /// this app and computer named) and asks for a reason where the client requires one.
    /// </summary>
    private async Task CopySecretAsync(SecretField field, string reason = "")
    {
        if (Results.SelectedItem is not SearchResult { IsPassword: true } result || app.Client is null)
            return;
        try
        {
            var secret = await app.Client.RevealForCopyAsync(result.Id, field, reason);
            clipboard.Copy(secret.Value, sensitive: true);
            Show(
                field == SecretField.OneTimeCode
                    ? $"Code copied. It changes in {secret.ExpiresIn ?? 30} seconds; the clipboard clears in 30."
                    : "Password copied. The clipboard clears in 30 seconds.",
                InfoBarSeverity.Success);
        }
        catch (AtlasApiException ex) when (ex.Code == "reason_required" && reason.Length == 0)
        {
            var given = await AskReasonAsync();
            if (given is not null)
                await CopySecretAsync(field, given);
        }
        catch (Exception ex) when (ex is AtlasApiException or HttpRequestException)
        {
            Fail(ex);
        }
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
            PrimaryButtonText = "Copy",
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
        Show(ex is HttpRequestException ? "Atlas could not be reached. Check your connection." : ex.Message, InfoBarSeverity.Error);
    }

    private void Show(string message, InfoBarSeverity severity)
    {
        StatusBar.Severity = severity;
        StatusBar.Message = message;
        StatusBar.IsOpen = true;
    }
}
