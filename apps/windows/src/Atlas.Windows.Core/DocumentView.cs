using System.Text;
using System.Text.Json;

namespace Atlas.Windows.Core;

/// <summary>
/// An Atlas document (the editor's tree of nodes) as blocks the app can draw: headings, paragraphs, lists and
/// checklists, quotes, code, lines, and tables, with bold, italic, underline, struck, highlighted, code and linked
/// text. Anything it doesn't know becomes a paragraph of its text, so nothing is silently lost.
/// </summary>
public static class DocumentView
{
    public static IReadOnlyList<DocBlock> Parse(JsonElement doc)
    {
        var blocks = new List<DocBlock>();
        if (doc.ValueKind == JsonValueKind.Object)
            AddBlocks(Children(doc), blocks);
        return blocks;
    }

    /// <summary>Whether the document has nothing to read.</summary>
    public static bool IsEmpty(IReadOnlyList<DocBlock> blocks) => blocks.All(b => b switch
    {
        DocParagraph p => p.Runs.All(r => string.IsNullOrWhiteSpace(r.Text)),
        DocHeading h => h.Runs.All(r => string.IsNullOrWhiteSpace(r.Text)),
        _ => false,
    });

    private static void AddBlocks(IEnumerable<JsonElement> nodes, List<DocBlock> blocks)
    {
        foreach (var node in nodes)
            if (ToBlock(node) is { } block)
                blocks.Add(block);
    }

    private static List<DocBlock> BlocksOf(JsonElement node)
    {
        var blocks = new List<DocBlock>();
        AddBlocks(Children(node), blocks);
        return blocks;
    }

    private static DocBlock? ToBlock(JsonElement node)
    {
        if (node.ValueKind != JsonValueKind.Object)
            return null;
        switch (TypeOf(node))
        {
            case "paragraph":
                return new DocParagraph(Runs(node), Align(node));
            case "heading":
                var level = Attr(node, "level") is { ValueKind: JsonValueKind.Number } l && l.TryGetInt32(out var n) ? n : 2;
                return new DocHeading(Math.Clamp(level, 1, 4), Runs(node), Align(node));
            case "bulletList":
                return new DocList(DocListKind.Bullets, 1, Items(node));
            case "orderedList":
                var start = Attr(node, "start") is { ValueKind: JsonValueKind.Number } s && s.TryGetInt32(out var first) ? first : 1;
                return new DocList(DocListKind.Numbers, start, Items(node));
            case "taskList":
                return new DocList(DocListKind.Checklist, 1, Items(node));
            case "blockquote":
                return new DocQuote(BlocksOf(node));
            case "codeBlock":
                var language = Attr(node, "language") is { ValueKind: JsonValueKind.String } lang ? lang.GetString() : null;
                return new DocCode(PlainText(node), string.IsNullOrWhiteSpace(language) ? null : language);
            case "horizontalRule":
                return new DocRule();
            case "table":
                return Table(node);
            case "text":
            case "hardBreak":
                // Text straight under a block: keep it, as a paragraph of its own.
                return new DocParagraph(Runs(Wrap(node)), DocAlign.Start);
            default:
                // Something this app doesn't know: its blocks if it has them, otherwise its text.
                var inner = BlocksOf(node);
                if (inner.Count > 0 && Children(node).All(c => TypeOf(c) is not ("text" or "hardBreak")))
                    return inner.Count == 1 ? inner[0] : new DocGroup(inner);
                var text = PlainText(node);
                return text.Length > 0 ? new DocParagraph([new DocRun(text, DocMarks.None, null)], DocAlign.Start) : null;
        }
    }

    private static List<DocListItem> Items(JsonElement list)
    {
        var items = new List<DocListItem>();
        foreach (var item in Children(list))
        {
            bool? done = TypeOf(item) == "taskItem" ? Attr(item, "checked") is { ValueKind: JsonValueKind.True } : null;
            items.Add(new DocListItem(done, BlocksOf(item)));
        }
        return items;
    }

    private static DocTable Table(JsonElement table)
    {
        var rows = new List<DocTableRow>();
        foreach (var row in Children(table))
        {
            var cells = new List<DocTableCell>();
            foreach (var cell in Children(row))
                cells.Add(new DocTableCell(
                    TypeOf(cell) == "tableHeader",
                    Span(cell, "colspan"),
                    Span(cell, "rowspan"),
                    BlocksOf(cell)));
            rows.Add(new DocTableRow(cells));
        }
        return new DocTable(rows);
    }

    private static int Span(JsonElement cell, string name) =>
        Attr(cell, name) is { ValueKind: JsonValueKind.Number } v && v.TryGetInt32(out var n) ? Math.Clamp(n, 1, 50) : 1;

    // ---------- text ----------
    private static List<DocRun> Runs(JsonElement block)
    {
        var runs = new List<DocRun>();
        foreach (var child in Children(block))
            switch (TypeOf(child))
            {
                case "text":
                    var text = child.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() ?? "" : "";
                    if (text.Length == 0)
                        break;
                    var (marks, link) = Marks(child);
                    if (runs.Count > 0 && runs[^1].Marks == marks && runs[^1].Link == link)
                        runs[^1] = runs[^1] with { Text = runs[^1].Text + text };
                    else
                        runs.Add(new DocRun(text, marks, link));
                    break;
                case "hardBreak":
                    runs.Add(new DocRun("\n", DocMarks.None, null));
                    break;
                default:
                    var inner = PlainText(child);
                    if (inner.Length > 0)
                        runs.Add(new DocRun(inner, DocMarks.None, null));
                    break;
            }
        return runs;
    }

    private static (DocMarks Marks, string? Link) Marks(JsonElement text)
    {
        var marks = DocMarks.None;
        string? link = null;
        if (text.TryGetProperty("marks", out var list) && list.ValueKind == JsonValueKind.Array)
            foreach (var mark in list.EnumerateArray())
                switch (TypeOf(mark))
                {
                    case "bold": marks |= DocMarks.Bold; break;
                    case "italic": marks |= DocMarks.Italic; break;
                    case "underline": marks |= DocMarks.Underline; break;
                    case "strike": marks |= DocMarks.Strike; break;
                    case "code": marks |= DocMarks.Code; break;
                    case "highlight": marks |= DocMarks.Highlight; break;
                    case "link":
                        if (Attr(mark, "href") is { ValueKind: JsonValueKind.String } href && SafeLink(href.GetString()) is { } safe)
                            link = safe;
                        break;
                }
        return (marks, link);
    }

    /// <summary>The link if it's one Atlas allows (web, mail, phone, or a path in Atlas), otherwise null.</summary>
    public static string? SafeLink(string? href)
    {
        if (string.IsNullOrWhiteSpace(href))
            return null;
        href = href.Trim();
        if (href.StartsWith('/') && !href.StartsWith("//", StringComparison.Ordinal))
            return href;
        return Uri.TryCreate(href, UriKind.Absolute, out var uri) && uri.Scheme is "https" or "http" or "mailto" or "tel" ? href : null;
    }

    private static string PlainText(JsonElement node)
    {
        var text = new StringBuilder();
        void Walk(JsonElement n)
        {
            switch (TypeOf(n))
            {
                case "text":
                    text.Append(n.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : "");
                    return;
                case "hardBreak":
                    text.Append('\n');
                    return;
            }
            var first = true;
            foreach (var child in Children(n))
            {
                // Separate blocks with a line; text runs stay together.
                if (!first && TypeOf(child) is not ("text" or "hardBreak") && text.Length > 0 && text[^1] != '\n')
                    text.Append('\n');
                first = false;
                Walk(child);
            }
        }
        Walk(node);
        return text.ToString();
    }

    // ---------- the tree ----------
    private static string? TypeOf(JsonElement node) =>
        node.ValueKind == JsonValueKind.Object && node.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;

    private static List<JsonElement> Children(JsonElement node) =>
        node.ValueKind == JsonValueKind.Object && node.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.Array
            ? [.. c.EnumerateArray()]
            : [];

    private static JsonElement? Attr(JsonElement node, string name) =>
        node.TryGetProperty("attrs", out var a) && a.ValueKind == JsonValueKind.Object && a.TryGetProperty(name, out var v) ? v : null;

    private static DocAlign Align(JsonElement node) =>
        Attr(node, "textAlign") is { ValueKind: JsonValueKind.String } a
            ? a.GetString() switch { "center" => DocAlign.Center, "right" => DocAlign.End, "justify" => DocAlign.Justify, _ => DocAlign.Start }
            : DocAlign.Start;

    private static JsonElement Wrap(JsonElement inline) =>
        JsonSerializer.SerializeToElement(new { type = "paragraph", content = new[] { inline } });
}

public abstract record DocBlock;
public sealed record DocParagraph(IReadOnlyList<DocRun> Runs, DocAlign Align) : DocBlock;
public sealed record DocHeading(int Level, IReadOnlyList<DocRun> Runs, DocAlign Align) : DocBlock;
public sealed record DocList(DocListKind Kind, int Start, IReadOnlyList<DocListItem> Items) : DocBlock;
/// <summary>A list item's blocks; <see cref="Done"/> is set for checklist items.</summary>
public sealed record DocListItem(bool? Done, IReadOnlyList<DocBlock> Blocks);
public sealed record DocQuote(IReadOnlyList<DocBlock> Blocks) : DocBlock;
public sealed record DocCode(string Text, string? Language) : DocBlock;
public sealed record DocRule : DocBlock;
public sealed record DocTable(IReadOnlyList<DocTableRow> Rows) : DocBlock;
public sealed record DocTableRow(IReadOnlyList<DocTableCell> Cells);
public sealed record DocTableCell(bool Header, int ColumnSpan, int RowSpan, IReadOnlyList<DocBlock> Blocks);
/// <summary>Blocks inside something this app doesn't know, kept together.</summary>
public sealed record DocGroup(IReadOnlyList<DocBlock> Blocks) : DocBlock;

/// <summary>A stretch of text with the same formatting. A line break is a run of "\n".</summary>
public sealed record DocRun(string Text, DocMarks Marks, string? Link);

public enum DocListKind { Bullets, Numbers, Checklist }
public enum DocAlign { Start, Center, End, Justify }

[Flags]
public enum DocMarks
{
    None = 0,
    Bold = 1,
    Italic = 2,
    Underline = 4,
    Strike = 8,
    Code = 16,
    Highlight = 32,
}
