using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace Atlas.Windows;

/// <summary>
/// Gives this app's shortcuts the Atlas's icon: the Start menu one the setup program makes, and any the person made on
/// the desktop or pinned to the taskbar. Only shortcuts that open this app are touched, and only their icon. Best
/// effort: a shortcut that can't be changed keeps the app's own icon.
/// </summary>
internal static class Shortcuts
{
    private const int MaxPath = 1024;
    private const uint ReadWrite = 2;

    /// <param name="icon">The .ico to show, or null for the app's own icon.</param>
    public static void UseIcon(string? icon)
    {
        if (Environment.ProcessPath is not { } app)
            return;
        var wanted = icon ?? app;
        var changed = false;
        string[] folders =
        [
            Environment.GetFolderPath(Environment.SpecialFolder.Programs),
            Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"),
        ];
        foreach (var folder in folders.Where(Directory.Exists))
        {
            foreach (var path in Directory.EnumerateFiles(folder, "*.lnk"))
            {
                try
                {
                    changed |= Point(path, app, wanted);
                }
                catch (Exception e) when (e is COMException or IOException or UnauthorizedAccessException or InvalidCastException or ArgumentException)
                {
                }
            }
        }
        // Tells Explorer to draw the shortcuts again with their new icons.
        if (changed)
            SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
    }

    private static bool Point(string path, string app, string icon)
    {
        var link = (IShellLinkW)new ShellLink();
        try
        {
            var file = (IPersistFile)link;
            file.Load(path, (int)ReadWrite);
            var target = new StringBuilder(MaxPath);
            link.GetPath(target, target.Capacity, IntPtr.Zero, 0);
            if (!string.Equals(Path.GetFullPath(target.ToString()), Path.GetFullPath(app), StringComparison.OrdinalIgnoreCase))
                return false;
            var current = new StringBuilder(MaxPath);
            link.GetIconLocation(current, current.Capacity, out var index);
            // The app's own icon may be written as no icon location at all.
            var now = current.Length == 0 ? app : current.ToString();
            if (string.Equals(now, icon, StringComparison.OrdinalIgnoreCase) && index == 0)
                return false;
            link.SetIconLocation(icon, 0);
            file.Save(path, true);
            return true;
        }
        finally
        {
            Marshal.ReleaseComObject(link);
        }
    }

    [DllImport("shell32.dll")]
    private static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);

    [ComImport]
    [Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink
    {
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("000214F9-0000-0000-C000-000000000046")]
    private interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int size, IntPtr findData, uint flags);
        void GetIDList(out IntPtr list);
        void SetIDList(IntPtr list);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int size);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int size);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int size);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int show);
        void SetShowCmd(int show);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int size, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
    }
}
