using Atlas.Windows.Core;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Windows.System;

namespace Atlas.Windows;

/// <summary>
/// The Settings page (account menu, or Ctrl+comma): how the app looks, the search shortcut, Windows Hello and locking,
/// notices, starting with Windows, updates, and the account. Each choice applies at once and is saved for this
/// Windows account on this PC.
/// </summary>
public sealed partial class SearchWindow
{
    private static readonly (string Label, string Value)[] ThemeChoices = [("Use my Windows setting", "system"), ("Light", "light"), ("Dark", "dark")];

    private void OpenSettings()
    {
        if (!hello.Locked && MainPanel.Visibility == Visibility.Visible && trail.LastOrDefault()?.Kind != "settings")
            Go(new Place("settings", "Settings"));
    }

    // ---------- theme ----------
    private void ApplyTheme()
    {
        Root.RequestedTheme = app.Settings.Theme switch
        {
            "light" => ElementTheme.Light,
            "dark" => ElementTheme.Dark,
            _ => ElementTheme.Default,
        };
        ColorCaptionButtons();
    }

    /// <summary>The minimise, maximise, and close buttons follow the app's theme, not only Windows'.</summary>
    private void ColorCaptionButtons()
    {
        var bar = AppWindow.TitleBar;
        var dark = Root.ActualTheme == ElementTheme.Dark;
        var ink = dark ? Colors.White : Colors.Black;
        bar.ButtonBackgroundColor = Colors.Transparent;
        bar.ButtonInactiveBackgroundColor = Colors.Transparent;
        bar.ButtonForegroundColor = ink;
        bar.ButtonHoverForegroundColor = ink;
        bar.ButtonPressedForegroundColor = ink;
        bar.ButtonHoverBackgroundColor = dark ? ColorHelper.FromArgb(0x18, 0xFF, 0xFF, 0xFF) : ColorHelper.FromArgb(0x10, 0, 0, 0);
        bar.ButtonPressedBackgroundColor = dark ? ColorHelper.FromArgb(0x10, 0xFF, 0xFF, 0xFF) : ColorHelper.FromArgb(0x0A, 0, 0, 0);
        bar.ButtonInactiveForegroundColor = dark ? ColorHelper.FromArgb(0x80, 0xFF, 0xFF, 0xFF) : ColorHelper.FromArgb(0x80, 0, 0, 0);
    }

    // ---------- search shortcut ----------
    /// <summary>Swaps the shortcut that opens search. False, keeping the old one, when another app already uses it.</summary>
    private bool ChangeShortcut(SearchShortcut shortcut)
    {
        if (!app.IsPreview)
        {
            Native.UnregisterHotKey(hwnd, HotkeyId);
            if (!Native.RegisterSearchHotkey(hwnd, HotkeyId, shortcut))
            {
                RegisterHotkey();
                return false;
            }
        }
        app.UpdateSettings(s => s with { Shortcut = shortcut.Id });
        app.ShortcutChanged();
        return true;
    }

    // ---------- the page ----------
    private void ShowSettings()
    {
        detailCancel?.Cancel();
        HideSecrets();
        password = null;
        current = null;
        ClearDetail();
        DetailScroll.ChangeView(null, 0, null, true);
        var settings = app.Settings;

        // How it looks.
        var theme = Choice("Theme", ThemeChoices.Select(t => t.Label), Array.FindIndex(ThemeChoices, t => t.Value == settings.Theme));
        theme.SelectionChanged += (_, _) =>
        {
            app.UpdateSettings(s => s with { Theme = ThemeChoices[Math.Max(0, theme.SelectedIndex)].Value });
            ApplyTheme();
        };
        Detail.Children.Add(Card("Appearance", SettingRow("Theme", "Light or dark, or the same as Windows.", theme)));

        // The shortcut.
        var shortcuts = SearchShortcut.Choices;
        var shortcut = Choice("Search shortcut", shortcuts.Select(c => c.Label), Math.Max(0, shortcuts.ToList().FindIndex(c => c.Id == settings.Shortcut)));
        var lastShortcut = shortcut.SelectedIndex;
        shortcut.SelectionChanged += (_, _) =>
        {
            if (shortcut.SelectedIndex < 0 || shortcut.SelectedIndex == lastShortcut)
                return;
            var chosen = shortcuts[shortcut.SelectedIndex];
            if (ChangeShortcut(chosen))
            {
                lastShortcut = shortcut.SelectedIndex;
                Show($"{chosen.Label} now opens search.", InfoBarSeverity.Success);
            }
            else
            {
                Show($"Another app already uses {chosen.Label}. Choose a different one.", InfoBarSeverity.Warning);
                shortcut.SelectedIndex = lastShortcut;
            }
        };
        Detail.Children.Add(Card(
            "Search",
            SettingRow("Search shortcut", "Opens search from anywhere in Windows. Inside the window, Ctrl+F does the same.", shortcut)));

        // Windows Hello and locking.
        if (helloAvailable)
        {
            var ask = Switch("Ask before showing or copying a password", settings.HelloForSecrets);
            ask.Toggled += (_, _) => ChangeHello(s => s with { HelloForSecrets = ask.IsOn });
            var grace = Choice("Ask again", GraceChoices.Select(g => g.Label), Array.FindIndex(GraceChoices, g => g.Minutes == settings.HelloGraceMinutes));
            grace.SelectionChanged += (_, _) => ChangeHello(s => s with { HelloGraceMinutes = GraceChoices[Math.Max(0, grace.SelectedIndex)].Minutes });
            var idle = Choice("Lock when the PC isn't used", LockChoices.Select(l => l.Label), Array.FindIndex(LockChoices, l => l.Minutes == settings.LockAfterMinutes));
            idle.SelectionChanged += (_, _) => ChangeHello(s => s with { LockAfterMinutes = LockChoices[Math.Max(0, idle.SelectedIndex)].Minutes });
            var lockNow = new Button { Content = "Lock now" };
            lockNow.Click += (_, _) => LockApp("You locked it.");
            Detail.Children.Add(Card(
                "Windows Hello",
                SettingRow("Ask before showing or copying a password", "Your face, fingerprint, or PIN, the same as signing in to Windows.", ask),
                SettingRow("Ask again", "One check covers the passwords you open for this long.", grace),
                SettingRow("Lock when the PC isn't used", "The window locks after this long without keyboard or mouse use. Windows Hello unlocks it.", idle),
                SettingRow("Lock the app now", "", lockNow)));
        }
        else
        {
            Detail.Children.Add(Card(
                "Windows Hello",
                Text("Windows Hello isn't set up on this PC, so passwords aren't checked before they're shown and the app doesn't lock. Set it up in Windows Settings › Accounts › Sign-in options, then open this page again.")));
        }

        // Notices and starting with Windows.
        var notices = Switch("Daily notice about what's coming due", settings.NotifyExpiring);
        notices.Toggled += (_, _) => app.UpdateSettings(s => s with { NotifyExpiring = notices.IsOn });
        var startup = Switch("Start with Windows", false);
        startup.IsEnabled = false;
        var startupRow = SettingRow("Start with Windows", "Opens in the tray when you sign in to Windows, ready for the shortcut.", startup);
        Detail.Children.Add(Card(
            "Notifications and startup",
            SettingRow("Daily notice about what's coming due", "Once a day, a Windows notification lists anything expiring in the next 14 days.", notices),
            startupRow));
        if (!app.IsPreview)
            _ = LoadStartupAsync(startup);

        // Updates.
        var check = new Button { Content = "Check for updates" };
        check.Click += (_, _) => CheckUpdates_Click(check, new RoutedEventArgs());
        var updateText = app.AvailableUpdate is { } offered && AppInfo.IsNewer(offered.LatestVersion)
            ? $"You have {AppInfo.VersionText}. Version {offered.LatestVersion} is ready to install from the bar at the top."
            : $"You have {AppInfo.VersionText}. Atlas checks for a newer one every six hours.";
        Detail.Children.Add(Card("Updates", SettingRow("Atlas for Windows", updateText, check)));

        // The account.
        if (app.Client is { } client)
        {
            var open = new Button { Content = "Open Atlas" };
            open.Click += (_, _) => _ = Launcher.LaunchUriAsync(client.Address.Origin);
            var signOut = new Button { Content = "Sign out" };
            signOut.Click += (_, _) => _ = app.SignOutAsync();
            AutomationProperties.SetName(signOut, "Sign out of Atlas");
            var who = AccountName.Text is { Length: > 0 } name ? Join(name, accountEmail) : "";
            Detail.Children.Add(Card(
                "Account",
                SettingRow("Atlas", client.Address.ToString(), open),
                SettingRow(who.Length > 0 ? who : "Signed in", "Signing out ends this app's session in Atlas. Your settings stay.", signOut)));
        }

        Detail.Children.Add(Footnote(
            "What this app keeps on this PC: the Atlas address, these settings, and your session, encrypted for your Windows account. "
            + "No passwords or documents are stored; they're fetched from Atlas when you open them."));
    }

    private async Task LoadStartupAsync(ToggleSwitch toggle)
    {
        var on = await app.StartsWithWindowsAsync();
        if (on is null)
            return;
        toggle.IsOn = on.Value;
        toggle.IsEnabled = true;
        toggle.Toggled += async (_, _) =>
        {
            if (toggle.IsOn == await app.StartsWithWindowsAsync())
                return;
            await app.ToggleStartupAsync();
            // Windows may have said no (or asked the person); show what it actually is now.
            var now = await app.StartsWithWindowsAsync();
            if (now is { } state && state != toggle.IsOn)
                toggle.IsOn = state;
        };
    }

    // ---------- building the rows ----------
    /// <summary>A setting: its name and what it does on the left, the control on the right.</summary>
    private static Grid SettingRow(string title, string description, FrameworkElement control)
    {
        var grid = new Grid { Padding = new Thickness(16, 12, 16, 12), ColumnSpacing = 24, MinHeight = 64 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Spacing = 2 };
        text.Children.Add(new TextBlock { Text = title, TextWrapping = TextWrapping.Wrap });
        if (description.Length > 0)
            text.Children.Add(new TextBlock { Text = description, FontSize = 12, TextWrapping = TextWrapping.Wrap, Foreground = Secondary() });
        control.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(control, 1);
        grid.Children.Add(text);
        grid.Children.Add(control);
        return grid;
    }

    private static ComboBox Choice(string name, IEnumerable<string> labels, int selected)
    {
        var box = new ComboBox { ItemsSource = labels.ToList(), SelectedIndex = Math.Max(0, selected), MinWidth = 220 };
        AutomationProperties.SetName(box, name);
        return box;
    }

    private static ToggleSwitch Switch(string name, bool on)
    {
        // The words beside the switch would repeat the row's name; the switch itself says on or off.
        var toggle = new ToggleSwitch { IsOn = on, OnContent = "On", OffContent = "Off", MinWidth = 0 };
        AutomationProperties.SetName(toggle, name);
        return toggle;
    }
}
