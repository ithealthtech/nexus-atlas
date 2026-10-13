using System.Security;
using Microsoft.Win32;

namespace Atlas.Windows;

/// <summary>
/// "Start with Windows" for the installed app: a value under the person's own Run key, which Windows reads at
/// sign-in. It needs no administrator rights and affects nobody else on the computer. The setup program writes the
/// same value when its "start when I sign in" box is ticked, and removes it on uninstall.
/// </summary>
internal static class StartupRegistration
{
    /// <summary>Tells the app Windows started it, so it stays in the tray instead of opening search.</summary>
    public const string Argument = "--startup";
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "Atlas for Windows";

    private static string? Command => Environment.ProcessPath is { } exe ? $"\"{exe}\" {Argument}" : null;

    public static bool IsEnabled() => Read() is { Length: > 0 };

    /// <summary>Turns it on or off. False when Windows refuses, which leaves the setting as it was.</summary>
    public static bool Set(bool enabled)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKey);
            if (!enabled)
                key.DeleteValue(ValueName, throwOnMissingValue: false);
            else if (Command is { } command)
                key.SetValue(ValueName, command);
            else
                return false;
            return true;
        }
        catch (Exception e) when (e is SecurityException or UnauthorizedAccessException or IOException)
        {
            return false;
        }
    }

    /// <summary>If it's on but points at a copy of the app somewhere else (it was moved), point it at this one.</summary>
    public static void KeepCurrent()
    {
        if (Native.IsPackaged())
            return;
        var saved = Read();
        if (saved is { Length: > 0 } && Command is { } command && !string.Equals(saved, command, StringComparison.OrdinalIgnoreCase))
            Set(true);
    }

    private static string? Read()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey);
            return key?.GetValue(ValueName) as string;
        }
        catch (Exception e) when (e is SecurityException or UnauthorizedAccessException or IOException)
        {
            return null;
        }
    }
}
