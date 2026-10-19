using Atlas.Windows.Core;
using H.NotifyIcon;
using H.NotifyIcon.Core;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Windows.AppLifecycle;
using ILaunchActivatedEventArgs = Windows.ApplicationModel.Activation.ILaunchActivatedEventArgs;
using StartupTask = Windows.ApplicationModel.StartupTask;
using StartupTaskState = Windows.ApplicationModel.StartupTaskState;

namespace Atlas.Windows;

/// <summary>
/// Atlas for Windows lives in the tray. Ctrl+Shift+Space (or clicking the tray icon) opens quick search; the tray
/// menu has sign-in, "Start with Windows", the newer version when Atlas offers one, and sign-out. It keeps only the
/// Atlas address, preferences, and a DPAPI-protected session token on disk.
/// </summary>
public partial class App : Application
{
    private const string StartupTaskId = "AtlasStartup";
    // Held while the app runs, so the installer can tell and ask it to close before replacing its files.
    private const string RunningMutexName = "AtlasForWindows.Running";
    // Asks the copy that is already running to quit cleanly (the installer uses it).
    private const string QuitArgument = "--quit";
    // Loads the window and the tray, reports whether that worked, and exits. Run by the build, never by people.
    private const string SelfTestArgument = "--self-test";
    private static readonly string SelfTestReport = Path.Combine(Path.GetTempPath(), "AtlasForWindows-selftest.txt");
    // Opens the window against made-up data (PreviewServer), with no sign-in, settings, or tray. The build uses it to
    // take screenshots; nothing it shows is real.
    private const string PreviewArgument = "--preview";

    private readonly SecureStore store = new(SecureStore.DefaultFolder(), new DpapiProtector());
    private AppSettings settings = new();
    private AtlasClient? client;
    private SearchWindow? window;
    private TaskbarIcon? tray;
    private MenuFlyoutItem? signInItem;
    private MenuFlyoutItem? updateItem;
    private ToggleMenuFlyoutItem? startupItem;
    private DispatcherQueueTimer? checkTimer;
    private DateOnly lastExpirationNotice;
    private AppRelease? update;
    private Mutex? running;
    private bool selfTest;

    public App()
    {
        InitializeComponent();
        UnhandledException += (_, e) =>
        {
            if (selfTest)
                FinishSelfTest(e.Exception);
            // Never write the exception anywhere: a message could quote a value. Show a generic notice instead.
            e.Handled = true;
            Notify("Something went wrong", "Atlas for Windows hit an error. Try again, or restart the app.");
        };
    }

    internal AtlasClient? Client => client;

    /// <summary>The person's choices for this app on this computer.</summary>
    internal AppSettings Settings => settings;

    internal void UpdateSettings(Func<AppSettings, AppSettings> change)
    {
        settings = change(settings);
        store.SaveSettings(settings);
    }

    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        var arguments = Environment.GetCommandLineArgs();
        if (HasArgument(arguments, SelfTestArgument))
        {
            RunSelfTest();
            return;
        }
        if (HasArgument(arguments, PreviewArgument))
        {
            client = new AtlasClient(PreviewServer.Address, new PreviewServer());
            client.UseToken(PreviewServer.Token);
            window = new SearchWindow(this);
            window.ShowSearch();
            return;
        }

        // One copy runs at a time; opening it again brings up search in the running copy, or tells it to quit.
        var main = AppInstance.FindOrRegisterForKey("main");
        if (!main.IsCurrent)
        {
            await main.RedirectActivationToAsync(AppInstance.GetCurrent().GetActivatedEventArgs());
            Exit();
            return;
        }
        if (HasArgument(arguments, QuitArgument))
        {
            // Nothing was running to quit.
            Exit();
            return;
        }
        main.Activated += (_, e) =>
        {
            var quit = WantsQuit(e);
            window?.DispatcherQueue.TryEnqueue(() =>
            {
                if (quit)
                    Quit();
                else
                    ShowSearch();
            });
        };
        running = new Mutex(false, RunningMutexName);

        Native.ExcludeFromErrorReporting();
        settings = store.LoadSettings();
        StartupRegistration.KeepCurrent();
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
            StartChecks();
            // Launched by hand (not at sign-in): show search so it's clear the app started.
            if (!IsStartupLaunch(arguments))
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
        StartChecks();
        Notify("Signed in to Atlas", $"Signed in as {token.User.Name}. Press Ctrl+Shift+Space to search.");
    }

    /// <summary>The server ended the session (signed out from the Account page, or by an administrator).</summary>
    internal void SessionEnded()
    {
        store.ForgetToken();
        checkTimer?.Stop();
        update = null;
        UpdateMenu();
        window?.ShowSetup(settings.AtlasUrl, "You were signed out of Atlas. Sign in again to continue.");
    }

    internal async Task SignOutAsync()
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
        checkTimer?.Stop();
        update = null;
        UpdateMenu();
        window?.ShowSetup(settings.AtlasUrl);
    }

    private void CreateTray()
    {
        signInItem = new MenuFlyoutItem { Command = new RelayCommand(() => _ = SignInOrOut()) };
        updateItem = new MenuFlyoutItem { Command = new RelayCommand(OpenUpdate), Visibility = Visibility.Collapsed };
        startupItem = new ToggleMenuFlyoutItem { Text = "Start with Windows", Command = new RelayCommand(() => _ = ToggleStartupAsync()) };
        var menu = new MenuFlyout();
        menu.Items.Add(new MenuFlyoutItem { Text = "Search Atlas    Ctrl+Shift+Space", Command = new RelayCommand(ShowSearch) });
        menu.Items.Add(updateItem);
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(startupItem);
        menu.Items.Add(signInItem);
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(new MenuFlyoutItem { Text = $"Version {AppInfo.VersionText}", IsEnabled = false });
        menu.Items.Add(new MenuFlyoutItem { Text = "Quit", Command = new RelayCommand(Quit) });
        tray = new TaskbarIcon
        {
            ToolTipText = "Atlas for Windows",
            // Loaded straight from the file next to the exe, which works installed and from a folder alike;
            // BitmapImage can't load a file: URI, and ms-appx: needs a package.
            Icon = new System.Drawing.Icon(Path.Combine(AppContext.BaseDirectory, "Assets", "Tray.ico")),
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
        if (updateItem is not null)
        {
            updateItem.Text = update is null ? "" : $"Get version {update.LatestVersion}…";
            updateItem.Visibility = update is null ? Visibility.Collapsed : Visibility.Visible;
        }
    }

    private static bool HasArgument(string[] arguments, string name) =>
        arguments.Contains(name, StringComparer.OrdinalIgnoreCase);

    /// <summary>Started by Windows at sign-in rather than by hand: stay in the tray without opening a window.</summary>
    private static bool IsStartupLaunch(string[] arguments) =>
        HasArgument(arguments, StartupRegistration.Argument)
        || AppInstance.GetCurrent().GetActivatedEventArgs().Kind == ExtendedActivationKind.StartupTask;

    /// <summary>Whether a second copy was started only to ask this one to quit.</summary>
    private static bool WantsQuit(AppActivationArguments activation) =>
        activation.Kind == ExtendedActivationKind.Launch
        && activation.Data is ILaunchActivatedEventArgs launch
        && launch.Arguments.Contains(QuitArgument, StringComparison.OrdinalIgnoreCase);

    // ---------- start with Windows ----------
    // Installed from the setup program (or run from a folder), the app registers itself under the person's own Run
    // key. Packaged as MSIX, Windows keeps the setting as a startup task instead.
    private async Task RefreshStartupItemAsync()
    {
        if (startupItem is null)
            return;
        if (!Native.IsPackaged())
        {
            startupItem.IsChecked = StartupRegistration.IsEnabled();
            return;
        }
        try
        {
            var task = await StartupTask.GetAsync(StartupTaskId);
            startupItem.IsChecked = task.State is StartupTaskState.Enabled or StartupTaskState.EnabledByPolicy;
        }
        catch (Exception e) when (e is InvalidOperationException or System.Runtime.InteropServices.COMException)
        {
            startupItem.IsEnabled = false;
        }
    }

    private async Task ToggleStartupAsync()
    {
        if (!Native.IsPackaged())
        {
            if (!StartupRegistration.Set(!StartupRegistration.IsEnabled()))
                Notify("Not available", "Windows didn't let Atlas for Windows change its startup setting.");
            settings = settings with { StartWithWindows = StartupRegistration.IsEnabled() };
            store.SaveSettings(settings);
            await RefreshStartupItemAsync();
            return;
        }
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
            Notify("Not available", "Windows didn't let Atlas for Windows change its startup setting.");
        }
        await RefreshStartupItemAsync();
    }

    // ---------- background checks ----------
    /// <summary>At start and every six hours: is there a newer version of this app, and is anything coming due.</summary>
    private void StartChecks()
    {
        if (window is null)
            return;
        if (checkTimer is null)
        {
            checkTimer = window.DispatcherQueue.CreateTimer();
            checkTimer.Interval = TimeSpan.FromHours(6);
            checkTimer.Tick += async (_, _) => await RunChecksAsync();
        }
        checkTimer.Start();
        _ = RunChecksAsync();
    }

    private async Task RunChecksAsync()
    {
        await CheckForUpdateAsync();
        if (settings.NotifyExpiring)
            await CheckExpirationsAsync();
    }

    /// <summary>
    /// Asks Atlas which version of this app it offers. A newer one is added to the tray menu and mentioned once;
    /// the app never downloads or replaces itself.
    /// </summary>
    private async Task CheckForUpdateAsync()
    {
        if (client is not { SignedIn: true })
            return;
        try
        {
            var session = await client.GetSessionAsync();
            var offered = session.App;
            update = offered is { DownloadLink: not null } && AppInfo.IsNewer(offered.LatestVersion) ? offered : null;
            UpdateMenu();
            if (update is not null && settings.UpdateNoticeFor != update.LatestVersion)
            {
                settings = settings with { UpdateNoticeFor = update.LatestVersion };
                store.SaveSettings(settings);
                Notify(
                    $"Atlas for Windows {update.LatestVersion} is available",
                    $"Choose “Get version {update.LatestVersion}” in the tray menu to download it.");
            }
        }
        catch (SessionEndedException)
        {
            SessionEnded();
        }
        catch (Exception e) when (e is HttpRequestException or AtlasApiException or TaskCanceledException or System.Text.Json.JsonException)
        {
            // Offline or Atlas unavailable; try again at the next check.
        }
    }

    private void OpenUpdate()
    {
        if (update?.DownloadLink is { } link)
            _ = global::Windows.System.Launcher.LaunchUriAsync(link);
    }

    /// <summary>Mentions items coming due in the next 14 days, once a day.</summary>
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

    // ---------- self-test ----------
    /// <summary>
    /// Builds the window (both of its panels) and the tray icon exactly as a normal start does, waits a moment for
    /// anything that fails late, then exits 0 and writes "ok", or exits 1 and writes what went wrong. Nothing here
    /// touches an Atlas server or anyone's data, so the report is safe to write.
    /// </summary>
    private void RunSelfTest()
    {
        selfTest = true;
        try
        {
            window = new SearchWindow(this);
            CreateTray();
            window.ShowSetup(null);
            window.ShowSearch();
            var timer = window.DispatcherQueue.CreateTimer();
            timer.Interval = TimeSpan.FromSeconds(3);
            timer.IsRepeating = false;
            timer.Tick += (_, _) => FinishSelfTest(null);
            timer.Start();
        }
        catch (Exception e)
        {
            FinishSelfTest(e);
        }
    }

    private void FinishSelfTest(Exception? error)
    {
        try
        {
            File.WriteAllText(SelfTestReport, error?.ToString() ?? "ok");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // The exit code still says how it went.
        }
        tray?.Dispose();
        Environment.Exit(error is null ? 0 : 1);
    }

    private void Quit()
    {
        window?.ClearClipboard();
        tray?.Dispose();
        client?.Dispose();
        running?.Dispose();
        window?.Shutdown();
        Exit();
    }
}
