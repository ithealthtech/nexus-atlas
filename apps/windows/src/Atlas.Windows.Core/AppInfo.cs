namespace Atlas.Windows.Core;

/// <summary>This app's own version (apps/windows/Directory.Build.props), and whether Atlas offers a newer one.</summary>
public static class AppInfo
{
    private static readonly Version Current = Normalize(typeof(AppInfo).Assembly.GetName().Version);

    /// <summary>For example "0.2.0".</summary>
    public static string VersionText { get; } = Current.ToString(3);

    /// <summary>Whether the version Atlas offers is newer than this one. Text that isn't a version never is.</summary>
    public static bool IsNewer(string? offered) => IsNewer(offered, Current);

    internal static bool IsNewer(string? offered, Version current) =>
        Version.TryParse(offered, out var version) && Normalize(version) > Normalize(current);

    // "0.3" and "0.3.0.0" both mean 0.3.0.
    private static Version Normalize(Version? version) =>
        version is null ? new Version(0, 0, 0) : new Version(version.Major, version.Minor, Math.Max(version.Build, 0));
}
