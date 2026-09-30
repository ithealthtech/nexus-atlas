namespace Atlas.Windows.Core;

/// <summary>The system clipboard, as the UI layer provides it.</summary>
public interface IClipboard
{
    /// <param name="sensitive">Secrets are kept out of clipboard history and cloud clipboard.</param>
    void SetText(string text, bool sensitive);

    /// <summary>The clipboard's text, or null if it holds something else.</summary>
    string? GetText();

    void Clear();
}

/// <summary>
/// Copies to the clipboard and clears secrets after 30 seconds, like the web app. It only clears what it put there:
/// if the person has copied something else since, that is left alone.
/// </summary>
public sealed class ClipboardGuard(IClipboard clipboard, TimeProvider time) : IDisposable
{
    public static readonly TimeSpan ClearAfter = TimeSpan.FromSeconds(30);
    private readonly Lock gate = new();
    private ITimer? timer;
    private string? pending;

    /// <summary>Raised on the timer's thread after a secret was cleared.</summary>
    public event EventHandler? Cleared;

    public void Copy(string text, bool sensitive)
    {
        ArgumentNullException.ThrowIfNull(text);
        lock (gate)
        {
            timer?.Dispose();
            timer = null;
            pending = null;
            clipboard.SetText(text, sensitive);
            if (!sensitive)
                return;
            pending = text;
            timer = time.CreateTimer(_ => ClearNow(), null, ClearAfter, Timeout.InfiniteTimeSpan);
        }
    }

    /// <summary>Clears a pending secret now (for example when the app exits).</summary>
    public void ClearNow()
    {
        bool cleared;
        lock (gate)
        {
            timer?.Dispose();
            timer = null;
            cleared = pending is not null && clipboard.GetText() == pending;
            if (cleared)
                clipboard.Clear();
            pending = null;
        }
        if (cleared)
            Cleared?.Invoke(this, EventArgs.Empty);
    }

    public void Dispose() => ClearNow();
}
