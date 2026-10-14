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
