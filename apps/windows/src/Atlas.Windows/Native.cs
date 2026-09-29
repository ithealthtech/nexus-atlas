using System.Runtime.InteropServices;
using Atlas.Windows.Core;

namespace Atlas.Windows;

/// <summary>The few Win32 calls WinUI doesn't cover: the global hotkey, the clipboard, and crash reporting.</summary>
internal static partial class Native
{
    public const int WM_HOTKEY = 0x0312;
    private const uint MOD_CONTROL = 0x0002;
    private const uint MOD_SHIFT = 0x0004;
    private const uint MOD_NOREPEAT = 0x4000;
    private const uint VK_SPACE = 0x20;
    private const uint CF_UNICODETEXT = 13;
    private const uint GMEM_MOVEABLE = 0x0002;

    public delegate IntPtr SubclassProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, UIntPtr id, UIntPtr data);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [DllImport("comctl32.dll")]
    public static extern bool SetWindowSubclass(IntPtr hWnd, SubclassProc proc, UIntPtr id, UIntPtr data);

    [DllImport("comctl32.dll")]
    public static extern IntPtr DefSubclassProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("wer.dll", CharSet = CharSet.Unicode)]
    private static extern int WerAddExcludedApplication(string exeName, bool allUsers);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool OpenClipboard(IntPtr owner);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EmptyClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetClipboardData(uint format, IntPtr data);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetClipboardData(uint format);

    [DllImport("user32.dll")]
    private static extern bool IsClipboardFormatAvailable(uint format);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint RegisterClipboardFormat(string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalLock(IntPtr mem);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalUnlock(IntPtr mem);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalFree(IntPtr mem);

    /// <summary>Ctrl+Shift+Space. Returns false if another app already uses it.</summary>
    public static bool RegisterSearchHotkey(IntPtr hWnd, int id) =>
        RegisterHotKey(hWnd, id, MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT, VK_SPACE);

    /// <summary>
    /// Keeps this app out of Windows Error Reporting, so a crash never uploads a memory dump that could hold a copied
    /// secret. Best effort: failure only means the Windows default applies.
    /// </summary>
    public static void ExcludeFromErrorReporting()
    {
        try
        {
            var exe = Environment.ProcessPath;
            if (exe is not null)
                _ = WerAddExcludedApplication(Path.GetFileName(exe), false);
        }
        catch (DllNotFoundException)
        {
        }
        catch (EntryPointNotFoundException)
        {
        }
    }

    /// <summary>
    /// The Win32 clipboard. It works from any thread (the clearing timer runs off the UI thread), and marks secrets so
    /// clipboard history, cloud clipboard, and clipboard monitors leave them out.
    /// </summary>
    public sealed class Clipboard(IntPtr owner) : IClipboard
    {
        private static readonly uint ExcludeFromMonitors = RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing");
        private static readonly uint AllowHistory = RegisterClipboardFormat("CanIncludeInClipboardHistory");
        private static readonly uint AllowCloud = RegisterClipboardFormat("CanUploadToCloudClipboard");

        public void SetText(string text, bool sensitive)
        {
            WithClipboard(() =>
            {
                EmptyClipboard();
                SetBytes(CF_UNICODETEXT, System.Text.Encoding.Unicode.GetBytes(text + '\0'));
                if (sensitive)
                {
                    SetBytes(ExcludeFromMonitors, [0, 0, 0, 0]);
                    SetBytes(AllowHistory, [0, 0, 0, 0]);
                    SetBytes(AllowCloud, [0, 0, 0, 0]);
                }
                return true;
            });
        }

        public string? GetText()
        {
            if (!IsClipboardFormatAvailable(CF_UNICODETEXT))
                return null;
            return WithClipboard(() =>
            {
                var handle = GetClipboardData(CF_UNICODETEXT);
                if (handle == IntPtr.Zero)
                    return null;
                var pointer = GlobalLock(handle);
                try
                {
                    return pointer == IntPtr.Zero ? null : Marshal.PtrToStringUni(pointer);
                }
                finally
                {
                    GlobalUnlock(handle);
                }
            });
        }

        public void Clear() => WithClipboard(EmptyClipboard);

        private T? WithClipboard<T>(Func<T> work)
        {
            // Another app may hold the clipboard for a moment; retry briefly.
            for (var attempt = 0; attempt < 10; attempt++)
            {
                if (OpenClipboard(owner))
                {
                    try
                    {
                        return work();
                    }
                    finally
                    {
                        CloseClipboard();
                    }
                }
                Thread.Sleep(20);
            }
            return default;
        }

        private static void SetBytes(uint format, byte[] bytes)
        {
            var memory = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)bytes.Length);
            if (memory == IntPtr.Zero)
                return;
            var pointer = GlobalLock(memory);
            Marshal.Copy(bytes, 0, pointer, bytes.Length);
            GlobalUnlock(memory);
            // On success the clipboard owns the memory; otherwise it's ours to free.
            if (SetClipboardData(format, memory) == IntPtr.Zero)
                GlobalFree(memory);
        }
    }
}
