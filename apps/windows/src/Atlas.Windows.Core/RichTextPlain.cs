using System.Text;
using System.Text.Json;

namespace Atlas.Windows.Core;

/// <summary>
/// Turns a document from Atlas's editor (a tree of nodes, each with text or more nodes) into plain text for reading
/// in the app: paragraphs and headings on their own lines, list items with a bullet or number, checklist items with
/// a box. Anything unknown contributes its text, so nothing is silently lost.
/// </summary>
public static class RichTextPlain
{
    public static string From(JsonElement doc)
    {
        var text = new StringBuilder();
        Block(doc, text, prefix: "");
        return string.Join('\n', text.ToString().Split('\n').Select(l => l.TrimEnd())).Trim();
    }

    private static void Block(JsonElement node, StringBuilder text, string prefix)
    {
        if (node.ValueKind != JsonValueKind.Object)
            return;
        var type = node.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
        var children = node.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.Array ? c : default;
        switch (type)
        {
            case "text":
                text.Append(node.TryGetProperty("text", out var s) ? s.GetString() : "");
                return;
            case "hardBreak":
                text.Append('\n').Append(prefix);
                return;
            case "paragraph":
            case "heading":
            case "codeBlock":
                text.Append(prefix);
                Inline(children, text);
                text.Append('\n');
                if (prefix.Length == 0)
                    text.Append('\n');
                return;
            case "bulletList":
            case "orderedList":
            case "taskList":
                var number = 1;
                if (children.ValueKind == JsonValueKind.Array)
                    foreach (var item in children.EnumerateArray())
                    {
                        var checkedBox = item.TryGetProperty("attrs", out var a) && a.TryGetProperty("checked", out var ch) && ch.ValueKind == JsonValueKind.True;
                        var mark = type switch
                        {
                            "orderedList" => $"{number++}. ",
                            "taskList" => checkedBox ? "☑ " : "☐ ",
                            _ => "• ",
                        };
                        ListItem(item, text, prefix + mark, prefix + new string(' ', mark.Length));
                    }
                if (prefix.Length == 0)
                    text.Append('\n');
                return;
            case "horizontalRule":
                text.Append(prefix).Append("———\n\n");
                return;
            default:
                if (children.ValueKind == JsonValueKind.Array)
                    foreach (var child in children.EnumerateArray())
                        Block(child, text, prefix);
                return;
        }
    }

    // A list item's first paragraph takes the bullet; anything after it is indented under it.
    private static void ListItem(JsonElement item, StringBuilder text, string first, string rest)
    {
        if (!item.TryGetProperty("content", out var parts) || parts.ValueKind != JsonValueKind.Array)
            return;
        var lead = true;
        foreach (var part in parts.EnumerateArray())
        {
            Block(part, text, lead ? first : rest);
            lead = false;
        }
    }

    private static void Inline(JsonElement children, StringBuilder text)
    {
        if (children.ValueKind != JsonValueKind.Array)
            return;
        foreach (var child in children.EnumerateArray())
            Block(child, text, "");
    }
}
