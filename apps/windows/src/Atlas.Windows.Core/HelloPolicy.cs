namespace Atlas.Windows.Core;

/// <summary>
/// When the app asks for Windows Hello: before a password or code is shown or copied, unless a check was passed in
/// the last few minutes; and to unlock the app after it locked itself for being left alone. The app only applies
/// this where Windows Hello is set up, since a lock nobody can open would shut the person out of their passwords.
/// </summary>
public sealed class HelloPolicy(TimeProvider time)
{
    private DateTimeOffset? verifiedAt;

    /// <summary>Ask before a password or code is shown or copied.</summary>
    public bool ForSecrets { get; set; } = true;

    /// <summary>How long one check covers. Zero asks every time.</summary>
    public TimeSpan Grace { get; set; } = TimeSpan.FromMinutes(5);

    /// <summary>How long the computer can go without keyboard or mouse use before the app locks. Null never locks.</summary>
    public TimeSpan? LockAfter { get; set; } = TimeSpan.FromMinutes(15);

    /// <summary>The app is locked: nothing shows until Windows Hello confirms it's the person.</summary>
    public bool Locked { get; private set; }

    public void Apply(AppSettings settings)
    {
        ForSecrets = settings.HelloForSecrets;
        Grace = TimeSpan.FromMinutes(Math.Max(0, settings.HelloGraceMinutes));
        LockAfter = settings.LockAfterMinutes > 0 ? TimeSpan.FromMinutes(settings.LockAfterMinutes) : null;
    }

    /// <summary>Whether showing or copying a secret needs a Windows Hello check first.</summary>
    public bool SecretNeedsCheck =>
        Locked || (ForSecrets && (Grace <= TimeSpan.Zero || verifiedAt is not { } at || time.GetUtcNow() - at >= Grace));

    /// <summary>
    /// Whether showing or copying this secret needs a Windows Hello check first. A restricted password always does,
    /// whatever the settings and however recent the last check, as the website asks for the password again.
    /// </summary>
    public bool SecretNeedsCheckFor(bool restricted) => restricted || SecretNeedsCheck;

    /// <summary>Whether the app should lock itself, given how long the computer has gone without input.</summary>
    public bool ShouldLock(TimeSpan idle) => !Locked && LockAfter is { } after && idle >= after;

    /// <summary>Windows Hello confirmed it's the person: unlocks the app and starts the grace period.</summary>
    public void Verified()
    {
        verifiedAt = time.GetUtcNow();
        Locked = false;
    }

    /// <summary>Locks the app; the next secret, or anything at all, needs a new check.</summary>
    public void Lock()
    {
        Locked = true;
        verifiedAt = null;
    }
}
