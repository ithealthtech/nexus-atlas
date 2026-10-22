using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using Windows.UI.ViewManagement;

namespace Atlas.Windows;

/// <summary>
/// Theme colours for elements built in code. Application.Current.Resources answers for the app's theme, which follows
/// Windows; when Settings picks light or dark for the window, the colours have to come from that theme instead, or a
/// card is drawn light behind light text. In high contrast, Windows' own colours always apply.
/// </summary>
internal static class Themed
{
    /// <summary>The window's theme, kept up to date by the window.</summary>
    public static ElementTheme Current { get; set; } = ElementTheme.Default;

    private static readonly AccessibilitySettings Accessibility = new();

    public static Brush Brush(string key) => (Brush)Get(key);

    public static object Get(string key)
    {
        var resources = Application.Current.Resources;
        if (Current == ElementTheme.Default || Accessibility.HighContrast)
            return resources[key];
        // Dark theme resources are filed as "Dark" in some dictionaries and "Default" in others.
        string[] names = Current == ElementTheme.Dark ? ["Dark", "Default"] : ["Light"];
        foreach (var name in names)
            if (Find(resources, name, key) is { } found)
                return found;
        return resources[key];
    }

    private static object? Find(ResourceDictionary dictionary, string theme, string key)
    {
        if (dictionary.ThemeDictionaries.TryGetValue(theme, out var themed) && themed is ResourceDictionary inner && inner.TryGetValue(key, out var value))
            return value;
        foreach (var merged in dictionary.MergedDictionaries)
            if (Find(merged, theme, key) is { } found)
                return found;
        return null;
    }
}
