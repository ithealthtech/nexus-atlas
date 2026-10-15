using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Atlas.Windows;

/// <summary>A place in the sidebar: starred, recent, or one kind of thing.</summary>
public sealed record Section(string Id, string Label, string Glyph)
{
    // What a screen reader says for the sidebar entry.
    public override string ToString() => Label;
}

/// <summary>A client in the sidebar. Choosing one narrows the list to it; "All clients" has no id.</summary>
public sealed record ClientChoice(string? Id, string Name)
{
    public string Initials => Id is null
        ? "★"
        : string.Concat(Name.Split(' ', StringSplitOptions.RemoveEmptyEntries).Take(2).Select(w => char.ToUpperInvariant(w[0])));
}

/// <summary>One line in the middle list.</summary>
public sealed record Row(string Kind, string Id, string Title, string Subtitle, string? ClientId, string? ClientName)
{
    public string Glyph => GlyphFor(Kind);

    /// <summary>On the Clients page, what each client row shows beyond its name.</summary>
    public ClientFacts? Facts { get; init; }

    // What a screen reader says for the row: its name, then the line under it.
    public override string ToString() => string.IsNullOrEmpty(Subtitle) ? Title : $"{Title}, {Subtitle}";

    public static string GlyphFor(string kind) => kind switch
    {
        "password" => "",
        "asset" => "",
        "document" => "",
        "client" => "",
        "contact" => "",
        "location" => "",
        _ => "",
    };
}

/// <summary>
/// A client's line in the Clients list: its tile, what it is, the start of its quick note, how much is documented,
/// and what needs attention. Counts are null when Atlas didn't say (for example, no access to passwords).
/// </summary>
public sealed record ClientFacts(
    string Initials,
    Brush Tile,
    string Line,
    string Note,
    string Status,
    int? Passwords,
    int? Assets,
    int? Documents,
    int Expiring,
    int Expired,
    bool Starred)
{
    public string PasswordsText => Count(Passwords);
    public string AssetsText => Count(Assets);
    public string DocumentsText => Count(Documents);
    public Visibility NoteVisibility => Shown(Note.Length > 0);
    public Visibility StatusVisibility => Shown(Status.Length > 0);
    public Visibility StarVisibility => Shown(Starred);
    public Visibility AttentionVisibility => Shown(Expiring + Expired > 0);
    public Visibility AllClearVisibility => Shown(Expiring + Expired == 0);

    public string Attention => (Expired, Expiring) switch
    {
        ( > 0, > 0) => $"{Expired} expired, {Expiring} soon",
        ( > 0, _) => $"{Expired} expired",
        _ => $"{Expiring} expiring",
    };

    public Brush AttentionBackground => (Brush)Application.Current.Resources[Expired > 0 ? "SystemFillColorCriticalBackgroundBrush" : "SystemFillColorCautionBackgroundBrush"];
    public Brush AttentionForeground => (Brush)Application.Current.Resources[Expired > 0 ? "SystemFillColorCriticalBrush" : "SystemFillColorCautionBrush"];

    private static string Count(int? value) => value is { } n ? n.ToString("N0", System.Globalization.CultureInfo.CurrentCulture) : "–";

    private static Visibility Shown(bool shown) => shown ? Visibility.Visible : Visibility.Collapsed;
}

/// <summary>Picks the client layout for client rows on the Clients page and the plain one for everything else.</summary>
public sealed partial class RowTemplates : DataTemplateSelector
{
    public DataTemplate? Plain { get; set; }

    public DataTemplate? Client { get; set; }

    protected override DataTemplate? SelectTemplateCore(object item) => item is Row { Facts: not null } ? Client : Plain;

    protected override DataTemplate? SelectTemplateCore(object item, DependencyObject container) => SelectTemplateCore(item);
}

/// <summary>Rows under one heading (a client, when the list spans every client).</summary>
public sealed class RowGroup(string key, IEnumerable<Row> rows) : List<Row>(rows)
{
    public string Key { get; } = key;

    public override string ToString() => Key;
}

/// <summary>An asset type in the list's filter, with how many there are.</summary>
public sealed record TypeChoice(string? LayoutId, string Label)
{
    public override string ToString() => Label;
}
