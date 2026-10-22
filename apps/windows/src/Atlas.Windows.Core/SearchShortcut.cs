namespace Atlas.Windows.Core;

/// <summary>
/// A shortcut that opens search from anywhere in Windows. Ctrl+Shift+Space unless the person picks another, for when
/// another app already uses it. Modifiers and key are the values RegisterHotKey takes.
/// </summary>
public sealed record SearchShortcut(string Id, string Label, uint Modifiers, uint Key)
{
    private const uint Alt = 0x0001;
    private const uint Control = 0x0002;
    private const uint Shift = 0x0004;
    private const uint Space = 0x20;
    private const uint K = 0x4B;

    public static SearchShortcut Default { get; } = new("ctrl+shift+space", "Ctrl+Shift+Space", Control | Shift, Space);

    public static IReadOnlyList<SearchShortcut> Choices { get; } =
    [
        Default,
        new("ctrl+alt+space", "Ctrl+Alt+Space", Control | Alt, Space),
        new("ctrl+shift+k", "Ctrl+Shift+K", Control | Shift, K),
        new("ctrl+alt+k", "Ctrl+Alt+K", Control | Alt, K),
    ];

    /// <summary>The shortcut saved in settings, or the default for anything it doesn't know.</summary>
    public static SearchShortcut For(string? id) => Choices.FirstOrDefault(c => c.Id == id) ?? Default;
}
