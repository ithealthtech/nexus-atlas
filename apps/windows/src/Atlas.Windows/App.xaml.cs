using Atlas.Windows.Core;
using H.NotifyIcon;
using H.NotifyIcon.Core;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.Windows.AppLifecycle;
using StartupTask = Windows.ApplicationModel.StartupTask;
using StartupTaskState = Windows.ApplicationModel.StartupTaskState;

namespace Atlas.Windows;

/// <summary>
/// Atlas for Windows lives in the tray. Ctrl+Shift+Space (or clicking the tray icon) opens quick search; the tray
/// menu has sign-in, "Start with Windows", and sign-out. It keeps only the Atlas address, preferences, and a
/// DPAPI-protected session token on disk.
/// </summary>
public partial class App : Application
{
    private const string StartupTaskId = "AtlasStartup";
    private readonly SecureStore store = new(SecureStore.DefaultFolder(), new DpapiProtector());
    private AppSettings settings = new();
    private AtlasClient? client;
    private SearchWindow? window;
    private TaskbarIcon? tray;
    private MenuFlyoutItem? signInItem;
    private ToggleMenuFlyoutItem? startupItem;
    private DispatcherQueueTimer? expirationTimer;
    private DateOnly lastExpirationNotice;

    public App()
    {
        InitializeComponent();
        UnhandledException += (_, e) =>
        {
            // Never write the exception anywhere: a message could quote a value. Show a generic notice instead.
            e.Handled = true;
            Notify("Something went wrong", "Atlas for Windows hit an error. Try again, or restart the app.");
        };
    }

    internal AtlasClient? Client => client;

    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        // One copy runs at a time; opening it again brings up search in the running copy.
        var main = AppInstance.FindOrRegisterForKey("main");
        if (!main.IsCurrent)
        {
            await main.RedirectActivationToAsync(AppInstance.GetCurrent().GetActivatedEventArgs());
            Exit();
            return;
        }
        main.Activated += (_, _) => window?.DispatcherQueue.TryEnqueue(ShowSearch);

        Native.ExcludeFromErrorReporting();
        settings = store.LoadSettings();
        window = new SearchWindow(this);
        CreateTray();
        if (!window.RegisterHotkey())
            Notify("Shortcut unavailable", "Another app uses Ctrl+Shift+Space. Open search from the tray icon instead.");

        if (settings.AtlasUrl is { } url && AtlasAddress.TryParse(url, out var address, out _))
        {
            client = new AtlasClient(address!);
            client.UseToken(store.LoadToken(address!));
        }
        UpdateMenu();
        if (client is { SignedIn: true })
        {
            StartExpirationChecks();
            // Launched by hand (not at sign-in): show search so it's clear the app started.
            if (!IsStartupLaunch())
                ShowSearch();
        }
        else
        {
            window.ShowSetup(settings.AtlasUrl);
        }
    }

    internal void ShowSearch()
    {
        if (window is null)
            return;
        if (client is not { SignedIn: true })
            window.ShowSetup(settings.AtlasUrl);
        else
            window.ShowSearch();
    }

    /// <summary>Signs in through the browser and keeps the session token (DPAPI-protected).</summary>
    internal async Task SignInAsync(AtlasAddress address, CancellationToken cancellationToken)
    {
        client?.Dispose();
        client = new AtlasClient(address);
        var token = await SignIn.RunAsync(
            client,
            SignIn.DeviceName(),
            uri => _ = global::Windows.System.Launcher.LaunchUriAsync(uri),
            cancellationToken);
        store.SaveToken(address, token.AccessToken);
        settings = settings with { AtlasUrl = address.ToString() };
        store.SaveSettings(settings);
        UpdateMenu();
        StartExpirationChecks();
        Notify("Signed in to Atlas", $"Signed in as {token.User.Name}. Press Ctrl+Shift+Space to search.");
    }

    /// <summary>The server ended the session (signed out from the Account page, or by an administrator).</summary>
    internal void SessionEnded()
    {
        store.ForgetToken();
        expirationTimer?.Stop();
        UpdateMenu();
        window?.ShowSetup(settings.AtlasUrl, "You were signed out of Atlas. Sign in again to continue.");
    }

    private async Task SignOutAsync()
    {
        if (client is not null)
        {
            try
            {
                await client.SignOutAsync();
            }
            catch (HttpRequestException)
            {
                // Offline: the token is still forgotten here, and it can be signed out from the Account page.
            }
        }
        window?.ClearClipboard();
        store.ForgetToken();
        expirationTimer?.Stop();
        UpdateMenu();
        window?.ShowSetup(settings.AtlasUrl);
    }

    private void CreateTray()
    {
        signInItem = new MenuFlyoutItem { Command = new RelayCommand(() => _ = SignInOrOut()) };
        startupItem = new ToggleMenuFlyoutItem { Text = "Start with Windows", Command = new RelayCommand(() => _ = ToggleStartupAsync()) };
        var menu = new MenuFlyout();
        menu.Items.Add(new MenuFlyoutItem { Text = "Search Atlas    Ctrl+Shift+Space", Command = new RelayCommand(ShowSearch) });
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(startupItem);
        menu.Items.Add(signInItem);
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(new MenuFlyoutItem { Text = "Quit", Command = new RelayCommand(Quit) });
        tray = new TaskbarIcon
        {
            ToolTipText = "Atlas for Windows",
            // A file path works installed (MSIX) and unpackaged (the preview zip) alike; ms-appx needs a package.
            IconSource = new BitmapImage(new Uri(Path.Combine(AppContext.BaseDirectory, "Assets", "Tray.ico"))),
            ContextMenuMode = ContextMenuMode.SecondWindow,
            ContextFlyout = menu,
            LeftClickCommand = new RelayCommand(ShowSearch),
            NoLeftClickDelay = true,
        };
        tray.ForceCreate(enablesEfficiencyMode: false);
        _ = RefreshStartupItemAsync();
    }

    private Task SignInOrOut()
    {
        if (client is { SignedIn: true })
            return SignOutAsync();
        window?.ShowSetup(settings.AtlasUrl);
        return Task.CompletedTask;
    }

    private void UpdateMenu()
    {
        if (signInItem is not null)
            signInItem.Text = client is { SignedIn: true } ? "Sign out" : "Sign in…";
    }

    private static bool IsStartupLaunch() =>
        AppInstance.GetCurrent().GetActivatedEventArgs().Kind == ExtendedActivationKind.StartupTask;

    private async Task RefreshStartupItemAsync()
    {
        if (startupItem is null)
            return;
        try
        {
            var task = await StartupTask.GetAsync(StartupTaskId);
            startupItem.IsChecked = task.State is StartupTaskState.Enabled or StartupTaskState.EnabledByPolicy;
        }
        catch (Exception e) when (e is InvalidOperationException or System.Runtime.InteropServices.COMException)
        {
            // Running unpackaged (development): there's no startup task.
            startupItem.IsEnabled = false;
        }
    }

    private async Task ToggleStartupAsync()
    {
        try
        {
            var task = await StartupTask.GetAsync(StartupTaskId);
            if (task.State is StartupTaskState.Enabled)
                task.Disable();
            else if (await task.RequestEnableAsync() is StartupTaskState.DisabledByUser)
                Notify("Start with Windows is off", "Turn Atlas for Windows on in Settings > Apps > Startup.");
            settings = settings with { StartWithWindows = task.State is StartupTaskState.Enabled };
            store.SaveSettings(settings);
        }
        catch (Exception e) when (e is InvalidOperationException or System.Runtime.InteropServices.COMException)
        {
            Notify("Not available", "Start with Windows needs the installed app.");
        }
        await RefreshStartupItemAsync();
    }

    /// <summary>Checks for items coming due at start and every six hours, and mentions them once a day.</summary>
    private void StartExpirationChecks()
    {
        if (!settings.NotifyExpiring || window is null)
            return;
        if (expirationTimer is null)
        {
            expirationTimer = window.DispatcherQueue.CreateTimer();
            expirationTimer.Interval = TimeSpan.FromHours(6);
            expirationTimer.Tick += async (_, _) => await CheckExpirationsAsync();
        }
        expirationTimer.Start();
        _ = CheckExpirationsAsync();
    }

    private async Task CheckExpirationsAsync()
    {
        if (client is not { SignedIn: true })
            return;
        var today = DateOnly.FromDateTime(DateTime.Now);
        if (lastExpirationNotice == today)
            return;
        try
        {
            var due = await client.GetExpirationsAsync(14);
            if (due.Count == 0)
                return;
            lastExpirationNotice = today;
            var soonest = due.OrderBy(d => d.DaysLeft).First();
            Notify(
                due.Count == 1 ? "1 item expires soon" : $"{due.Count} items expire in the next 14 days",
                $"{soonest.Title} ({soonest.Label}) {(soonest.DaysLeft <= 0 ? "is due now" : $"in {soonest.DaysLeft} days")}.");
        }
        catch (SessionEndedException)
        {
            SessionEnded();
        }
        catch (Exception e) when (e is HttpRequestException or AtlasApiException or TaskCanceledException)
        {
            // Offline or Atlas unavailable; try again at the next check.
        }
    }

    internal void Notify(string title, string message) =>
        tray?.ShowNotification(title, message, NotificationIcon.Info);

    private void Quit()
    {
        window?.ClearClipboard();
        tray?.Dispose();
        client?.Dispose();
        window?.Shutdown();
        Exit();
    }
}
