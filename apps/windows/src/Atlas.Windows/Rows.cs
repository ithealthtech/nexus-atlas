namespace Atlas.Windows;

/// <summary>A place in the sidebar: starred, recent, or one kind of thing.</summary>
public sealed record Section(string Id, string Label, string Glyph);

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
