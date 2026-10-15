using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Atlas.Windows.Core;

/// <summary>
/// Atlas documents as text the app can edit, and back. Formatting is written the way people type it:
/// <c># Heading</c>, <c>- item</c>, <c>1. item</c>, <c>- [ ] task</c>, <c>&gt; quote</c>, <c>```</c> code blocks,
/// <c>---</c> for a line, <c>**bold**</c>, <c>*italic*</c>, <c>~~struck~~</c>, <c>&lt;u&gt;underlined&lt;/u&gt;</c>,
/// <c>==highlighted==</c>, <c>`code`</c> and <c>[text](https://link)</c>. A blank line starts a new paragraph,
/// and a line indented by two spaces belongs to the list item above it.
/// <para>
/// Documents with things the text can't hold (tables, centred text) are never edited as text: <see cref="TryEditable"/>
/// converts the document to text and back and only says yes when nothing changed, so saving can't lose anything.
/// </para>
/// </summary>
public static partial class DocumentText
{
    // Characters a backslash makes literal inside a line.
    private const string Escapable = "*`[]~=<";

    /// <summary>The document as text, if it can be edited as text without losing anything.</summary>
    public static bool TryEditable(JsonElement doc, out string text)
    {
        text = "";
        try
        {
            var written = ToText(doc);
            var back = JsonSerializer.SerializeToElement(FromText(written));
            if (Canonical(doc) != Canonical(back))
                return false;
            text = written;
            return true;
        }
        catch (NotSupportedException)
        {
            return false;
        }
    }

    // ---------- document to text ----------

    /// <summary>Writes the document as text. Throws <see cref="NotSupportedException"/> for content text can't hold.</summary>
    public static string ToText(JsonElement doc)
    {
        var lines = new List<string>();
        Blocks(Children(doc), lines);
        return string.Join('\n', lines);
    }

    private static void Blocks(IEnumerable<JsonElement> blocks, List<string> lines)
    {
        var first = true;
        foreach (var block in blocks)
        {
            if (IsEmptyParagraph(block))
                continue;
            if (!first)
                lines.Add("");
            first = false;
            Block(block, lines);
        }
    }

    private static void Block(JsonElement node, List<string> lines)
    {
        var type = TypeOf(node);
        switch (type)
        {
            case "paragraph":
                NoAlignment(node);
                lines.AddRange(Inline(node).Split('\n').Select(EscapeLineStart));
                return;
            case "heading":
                NoAlignment(node);
                var level = Attr(node, "level") is { ValueKind: JsonValueKind.Number } l ? l.GetInt32() : 2;
                var heading = Inline(node);
                if (heading.Contains('\n', StringComparison.Ordinal) || heading.Length == 0)
                    throw new NotSupportedException("A heading with a line break or without text.");
                lines.Add(new string('#', Math.Clamp(level, 1, 4)) + " " + heading);
                return;
            case "blockquote":
                var quoted = new List<string>();
                Blocks(Children(node), quoted);
                lines.AddRange(quoted.Select(q => q.Length == 0 ? ">" : "> " + q));
                return;
            case "codeBlock":
                var language = Attr(node, "language") is { ValueKind: JsonValueKind.String } lang ? lang.GetString() : null;
                var code = new StringBuilder();
                foreach (var part in Children(node))
                {
                    if (TypeOf(part) != "text" || part.TryGetProperty("marks", out _))
                        throw new NotSupportedException("Formatting inside a code block.");
                    code.Append(part.GetProperty("text").GetString());
                }
                var codeLines = code.ToString().Split('\n');
                if (codeLines.Any(c => c.TrimEnd().StartsWith("```", StringComparison.Ordinal)))
                    throw new NotSupportedException("A code block containing a fence.");
                lines.Add("```" + language);
                if (code.Length > 0)
                    lines.AddRange(codeLines);
                lines.Add("```");
                return;
            case "horizontalRule":
                lines.Add("---");
                return;
            case "bulletList":
            case "orderedList":
            case "taskList":
                var number = Attr(node, "start") is { ValueKind: JsonValueKind.Number } s ? s.GetInt32() : 1;
                foreach (var item in Children(node))
                {
                    var marker = type switch
                    {
                        "orderedList" => $"{number++}.",
                        "taskList" => Attr(item, "checked") is { ValueKind: JsonValueKind.True } ? "- [x]" : "- [ ]",
                        _ => "-",
                    };
                    var inside = new List<string>();
                    Blocks(Children(item), inside);
                    if (inside.Count == 0 || inside[0].Length == 0)
                        lines.Add(marker);
                    else
                        lines.Add(marker + " " + inside[0]);
                    lines.AddRange(inside.Skip(1).Select(i => i.Length == 0 ? "" : "  " + i));
                }
                return;
            default:
                throw new NotSupportedException($"Content the app can't edit as text ({type}).");
        }
    }

    private static void NoAlignment(JsonElement node)
    {
        if (Attr(node, "textAlign") is { ValueKind: JsonValueKind.String })
            throw new NotSupportedException("Aligned text.");
    }

    // A line that would read as a heading, list item, quote, or line is written with a backslash in front.
    private static string EscapeLineStart(string line)
    {
        if (line.Length > 0 && char.IsWhiteSpace(line[0]))
            throw new NotSupportedException("A line starting with spaces.");
        if (UnescapeLineStart(line) != line)
            throw new NotSupportedException("A line starting with a backslash.");
        if (!StartsBlock(line))
            return line;
        if (line[0] is '#' or '-' or '>')
            return "\\" + line;
        var digits = 0;
        while (digits < line.Length && char.IsAsciiDigit(line[digits]))
            digits++;
        if (digits > 0)
            return line[..digits] + "\\" + line[digits..];
        throw new NotSupportedException("A line that reads as formatting.");
    }

    private sealed record Run(string Text, SortedSet<string> Marks, string? Href, bool Break);

    // The text of a paragraph or heading, with formatting written around it and line breaks as new lines.
    private static string Inline(JsonElement node)
    {
        var runs = new List<Run>();
        foreach (var part in Children(node))
        {
            switch (TypeOf(part))
            {
                case "hardBreak":
                    runs.Add(new Run("", [], null, true));
                    break;
                case "text":
                    var marks = new SortedSet<string>(StringComparer.Ordinal);
                    string? href = null;
                    if (part.TryGetProperty("marks", out var list))
                        foreach (var mark in list.EnumerateArray())
                        {
                            var name = TypeOf(mark) ?? "";
                            if (name == "link")
                                href = Attr(mark, "href")?.GetString();
                            else if (name is "bold" or "italic" or "strike" or "underline" or "highlight" or "code")
                                marks.Add(name);
                            else
                                throw new NotSupportedException($"Formatting the app can't edit as text ({name}).");
                        }
                    var text = part.GetProperty("text").GetString() ?? "";
                    // Neighbours with the same formatting are one run.
                    if (runs.Count > 0 && runs[^1] is { Break: false } last && last.Href == href && last.Marks.SetEquals(marks))
                        runs[^1] = last with { Text = last.Text + text };
                    else
                        runs.Add(new Run(text, marks, href, false));
                    break;
                default:
                    throw new NotSupportedException($"Content the app can't edit as text ({TypeOf(part)}).");
            }
        }

        var output = new StringBuilder();
        var open = new SortedSet<string>(StringComparer.Ordinal);
        string? link = null;
        var codeOpen = false;
        void Change(SortedSet<string> marks, string? href)
        {
            var others = new SortedSet<string>(marks.Where(m => m != "code"), StringComparer.Ordinal);
            var openOthers = new SortedSet<string>(open.Where(m => m != "code"), StringComparer.Ordinal);
            var changing = href != link || !others.SetEquals(openOthers);
            if (codeOpen && (changing || !marks.Contains("code")))
            {
                output.Append('`');
                codeOpen = false;
            }
            if (href != link && link is not null)
                output.Append("](").Append(link).Append(')');
            foreach (var mark in openOthers.Except(others).Concat(others.Except(openOthers)))
                output.Append(Delimiter(mark, others.Contains(mark)));
            if (href != link && href is not null)
            {
                if (href.Any(c => c is ')' or '(' or ' ' or '\n'))
                    throw new NotSupportedException("A link address with spaces or brackets.");
                output.Append('[');
            }
            link = href;
            if (marks.Contains("code") && !codeOpen)
            {
                output.Append('`');
                codeOpen = true;
            }
            open = new SortedSet<string>(marks, StringComparer.Ordinal);
        }
        for (var i = 0; i < runs.Count; i++)
        {
            var run = runs[i];
            if (run.Break)
            {
                // Code can't hold a line break; everything else carries on to the next line.
                if (codeOpen)
                    throw new NotSupportedException("A line break inside code.");
                // A link ends at the end of its line.
                if (link is not null)
                    Change(open, null);
                output.Append('\n');
                continue;
            }
            Change(run.Marks, run.Href);
            if (run.Marks.Contains("code"))
            {
                if (run.Text.Contains('`', StringComparison.Ordinal))
                    throw new NotSupportedException("A backtick inside code.");
                output.Append(run.Text);
            }
            else
            {
                if (run.Text.EndsWith('\\') && i + 1 < runs.Count && !runs[i + 1].Break)
                    throw new NotSupportedException("A backslash before formatting.");
                output.Append(Escape(run.Text));
            }
        }
        Change([], null);
        return output.ToString();
    }

    private static string Delimiter(string mark, bool opening) => mark switch
    {
        "bold" => "**",
        "italic" => "*",
        "strike" => "~~",
        "highlight" => "==",
        "underline" => opening ? "<u>" : "</u>",
        _ => throw new NotSupportedException(mark),
    };

    private static string Escape(string text)
    {
        var output = new StringBuilder(text.Length + 8);
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            char? next = i + 1 < text.Length ? text[i + 1] : null;
            switch (c)
            {
                case '*' or '`' or '[' or ']':
                    output.Append('\\').Append(c);
                    break;
                case '~' or '=' when next is null || next == c:
                    output.Append('\\').Append(c);
                    break;
                case '<' when text.AsSpan(i).StartsWith("<u>") || text.AsSpan(i).StartsWith("</u>"):
                    output.Append("\\<");
                    break;
                case '\\' when next is { } n && Escapable.Contains(n, StringComparison.Ordinal):
                    // A backslash before a character that a backslash escapes: keep both, escaping the second.
                    output.Append("\\\\").Append(n);
                    i++;
                    break;
                default:
                    output.Append(c);
                    break;
            }
        }
        return output.ToString();
    }

    // ---------- text to document ----------

    /// <summary>Reads text written as described above into an Atlas document.</summary>
    public static JsonObject FromText(string text)
    {
        var lines = text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n').ToList();
        return new JsonObject { ["type"] = "doc", ["content"] = new JsonArray([.. ParseBlocks(lines)]) };
    }

    [GeneratedRegex(@"^(#{1,4}) (.+)$")]
    private static partial Regex HeadingLine();

    [GeneratedRegex(@"^- \[( |x|X)\](?: (.*))?$")]
    private static partial Regex TaskLine();

    [GeneratedRegex(@"^-(?: (.*))?$")]
    private static partial Regex BulletLine();

    [GeneratedRegex(@"^(\d{1,9})\.(?: (.*))?$")]
    private static partial Regex NumberLine();

    private static string? ListKind(string line) =>
        TaskLine().IsMatch(line) ? "taskList" : line.TrimEnd() != "---" && BulletLine().IsMatch(line) ? "bulletList" : NumberLine().IsMatch(line) ? "orderedList" : null;

    private static bool StartsBlock(string line) =>
        line.StartsWith("```", StringComparison.Ordinal) || HeadingLine().IsMatch(line) || line.TrimEnd() == "---" || line.StartsWith('>') || ListKind(line) is not null;

    private static List<JsonNode> ParseBlocks(List<string> lines)
    {
        var blocks = new List<JsonNode>();
        var i = 0;
        while (i < lines.Count)
        {
            var line = lines[i];
            if (line.Trim().Length == 0)
            {
                i++;
                continue;
            }
            if (line.StartsWith("```", StringComparison.Ordinal))
            {
                var language = line[3..].Trim();
                var code = new List<string>();
                i++;
                while (i < lines.Count && lines[i].TrimEnd() != "```")
                    code.Add(lines[i++]);
                i++;
                var block = new JsonObject { ["type"] = "codeBlock", ["attrs"] = new JsonObject { ["language"] = language.Length > 0 ? language : null } };
                var body = string.Join('\n', code);
                if (body.Length > 0)
                    block["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = body });
                blocks.Add(block);
                continue;
            }
            if (HeadingLine().Match(line) is { Success: true } heading)
            {
                blocks.Add(new JsonObject
                {
                    ["type"] = "heading",
                    ["attrs"] = new JsonObject { ["level"] = heading.Groups[1].Length },
                    ["content"] = new JsonArray([.. ParseInline(heading.Groups[2].Value)]),
                });
                i++;
                continue;
            }
            if (line.TrimEnd() == "---")
            {
                blocks.Add(new JsonObject { ["type"] = "horizontalRule" });
                i++;
                continue;
            }
            if (line.StartsWith('>'))
            {
                var quoted = new List<string>();
                while (i < lines.Count && lines[i].StartsWith('>'))
                {
                    var q = lines[i++];
                    quoted.Add(q.StartsWith("> ", StringComparison.Ordinal) ? q[2..] : q[1..]);
                }
                blocks.Add(new JsonObject { ["type"] = "blockquote", ["content"] = new JsonArray([.. ParseBlocks(quoted)]) });
                continue;
            }
            if (ListKind(line) is { } kind)
            {
                blocks.Add(ParseList(lines, ref i, kind));
                continue;
            }
            var paragraph = new List<string> { UnescapeLineStart(line) };
            i++;
            while (i < lines.Count && lines[i].Trim().Length > 0 && !StartsBlock(lines[i]))
                paragraph.Add(UnescapeLineStart(lines[i++]));
            var inline = ParseInline(string.Join('\n', paragraph));
            var node = new JsonObject { ["type"] = "paragraph" };
            if (inline.Count > 0)
                node["content"] = new JsonArray([.. inline]);
            blocks.Add(node);
        }
        return blocks;
    }

    private static JsonObject ParseList(List<string> lines, ref int i, string kind)
    {
        var items = new JsonArray();
        var start = 1;
        while (i < lines.Count && ListKind(lines[i]) == kind)
        {
            var line = lines[i];
            string first;
            var item = new JsonObject { ["type"] = kind == "taskList" ? "taskItem" : "listItem" };
            if (kind == "taskList")
            {
                var task = TaskLine().Match(line);
                item["attrs"] = new JsonObject { ["checked"] = task.Groups[1].Value != " " };
                first = task.Groups[2].Value;
            }
            else if (kind == "orderedList")
            {
                var numbered = NumberLine().Match(line);
                if (items.Count == 0)
                    start = int.Parse(numbered.Groups[1].Value, CultureInfo.InvariantCulture);
                first = numbered.Groups[2].Value;
            }
            else
                first = BulletLine().Match(line).Groups[1].Value;
            var inside = new List<string> { first };
            i++;
            while (i < lines.Count)
            {
                if (lines[i].StartsWith("  ", StringComparison.Ordinal))
                {
                    inside.Add(lines[i++][2..]);
                    continue;
                }
                if (lines[i].Trim().Length == 0)
                {
                    // A blank line keeps the item going only when an indented line follows it.
                    var j = i;
                    while (j < lines.Count && lines[j].Trim().Length == 0)
                        j++;
                    if (j < lines.Count && lines[j].StartsWith("  ", StringComparison.Ordinal))
                    {
                        for (; i < j; i++)
                            inside.Add("");
                        continue;
                    }
                }
                break;
            }
            var content = ParseBlocks(inside);
            if (content.Count == 0)
                content.Add(new JsonObject { ["type"] = "paragraph" });
            item["content"] = new JsonArray([.. content]);
            items.Add(item);
        }
        var list = new JsonObject { ["type"] = kind };
        if (kind == "orderedList")
            list["attrs"] = new JsonObject { ["start"] = start };
        list["content"] = items;
        return list;
    }

    private static string UnescapeLineStart(string line)
    {
        if (line.Length > 1 && line[0] == '\\' && line[1] is '#' or '-' or '>')
            return line[1..];
        var digits = 0;
        while (digits < line.Length && char.IsAsciiDigit(line[digits]))
            digits++;
        if (digits > 0 && line.AsSpan(digits).StartsWith("\\."))
            return line[..digits] + line[(digits + 1)..];
        return line;
    }

    private static List<JsonNode> ParseInline(string text)
    {
        var nodes = new List<JsonNode>();
        var marks = new SortedSet<string>(StringComparer.Ordinal);
        var run = new StringBuilder();
        var linkStart = -1;

        void Add(string value, IEnumerable<string> with)
        {
            var markList = with.OrderBy(m => m, StringComparer.Ordinal).ToList();
            if (nodes.Count > 0 && nodes[^1] is JsonObject last && last["type"]!.GetValue<string>() == "text" && SameMarks(last, markList) && nodes.Count - 1 >= linkStart)
            {
                last["text"] = last["text"]!.GetValue<string>() + value;
                return;
            }
            var node = new JsonObject { ["type"] = "text", ["text"] = value };
            if (markList.Count > 0)
                node["marks"] = new JsonArray([.. markList.Select(m => (JsonNode)new JsonObject { ["type"] = m })]);
            nodes.Add(node);
        }
        void Flush()
        {
            if (run.Length > 0)
                Add(run.ToString(), marks);
            run.Clear();
        }

        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            var rest = text.AsSpan(i);
            if (c == '\\' && i + 1 < text.Length && Escapable.Contains(text[i + 1], StringComparison.Ordinal))
            {
                run.Append(text[++i]);
                continue;
            }
            if (c == '\n')
            {
                Flush();
                nodes.Add(new JsonObject { ["type"] = "hardBreak" });
                continue;
            }
            if (c == '`')
            {
                var end = text.IndexOf('`', i + 1);
                if (end > i + 1 && !text.AsSpan(i + 1, end - i - 1).Contains('\n'))
                {
                    Flush();
                    Add(text[(i + 1)..end], marks.Append("code"));
                    i = end;
                    continue;
                }
                run.Append(c);
                continue;
            }
            if (c == '[' && linkStart < 0 && LinkAhead(text, i) is not null)
            {
                Flush();
                linkStart = nodes.Count;
                continue;
            }
            if (c == ']' && linkStart >= 0 && LinkAhead(text, i) is { } href)
            {
                Flush();
                for (var n = linkStart; n < nodes.Count; n++)
                    if (nodes[n] is JsonObject { } linked && linked["type"]!.GetValue<string>() == "text")
                    {
                        var link = new JsonObject { ["type"] = "link", ["attrs"] = new JsonObject { ["href"] = href } };
                        if (linked["marks"] is JsonArray list)
                            list.Add(link);
                        else
                            linked["marks"] = new JsonArray(link);
                    }
                i += 2 + href.Length;
                linkStart = -1;
                // Text after the link never joins the link's last run.
                nodes.Add(new JsonObject { ["type"] = "boundary" });
                continue;
            }
            (string? Name, int Length) delimiter = rest.StartsWith("**") ? ("bold", 2)
                : c == '*' ? ("italic", 1)
                : rest.StartsWith("~~") ? ("strike", 2)
                : rest.StartsWith("==") ? ("highlight", 2)
                : rest.StartsWith("<u>") ? ("underline+", 3)
                : rest.StartsWith("</u>") ? ("underline-", 4)
                : (null, 0);
            // A delimiter with space on both sides, like the star in "5 * 3", is just text.
            if (delimiter.Name is not null
                && (i == 0 || char.IsWhiteSpace(text[i - 1]))
                && (i + delimiter.Length >= text.Length || char.IsWhiteSpace(text[i + delimiter.Length])))
            {
                run.Append(text, i, delimiter.Length);
                i += delimiter.Length - 1;
                continue;
            }
            if (delimiter.Name is { } name)
            {
                Flush();
                if (name == "underline+")
                    marks.Add("underline");
                else if (name == "underline-")
                    marks.Remove("underline");
                else if (!marks.Remove(name))
                    marks.Add(name);
                i += delimiter.Length - 1;
                continue;
            }
            run.Append(c);
        }
        Flush();
        nodes.RemoveAll(n => n["type"]!.GetValue<string>() == "boundary");
        return Merge(nodes);
    }

    // Where "[" or "]" begins a link, the address it points to: "[text](address)" all on one line.
    private static string? LinkAhead(string text, int at)
    {
        var close = text[at] == ']' ? at : FindUnescaped(text, ']', at + 1);
        if (close < 0 || close + 1 >= text.Length || text[close + 1] != '(')
            return null;
        var end = text.IndexOf(')', close + 2);
        if (end < 0)
            return null;
        var href = text[(close + 2)..end];
        return href.Length == 0 || href.Any(char.IsWhiteSpace) || text.AsSpan(at, close - at).Contains('\n') ? null : href;
    }

    private static int FindUnescaped(string text, char wanted, int from)
    {
        for (var i = from; i < text.Length; i++)
        {
            if (text[i] == '\\' && i + 1 < text.Length && Escapable.Contains(text[i + 1], StringComparison.Ordinal))
                i++;
            else if (text[i] == wanted)
                return i;
            else if (text[i] == '\n')
                return -1;
        }
        return -1;
    }

    private static bool SameMarks(JsonObject node, List<string> marks)
    {
        var existing = node["marks"] as JsonArray;
        if (existing is null)
            return marks.Count == 0;
        return existing.Select(m => m!["type"]!.GetValue<string>()).SequenceEqual(marks) && !existing.Any(m => m!["type"]!.GetValue<string>() == "link");
    }

    private static List<JsonNode> Merge(List<JsonNode> nodes)
    {
        var merged = new List<JsonNode>();
        foreach (var node in nodes)
        {
            if (merged.Count > 0 && merged[^1] is JsonObject last && node is JsonObject next
                && last["type"]!.GetValue<string>() == "text" && next["type"]!.GetValue<string>() == "text"
                && JsonNode.DeepEquals(last["marks"], next["marks"]))
            {
                last["text"] = last["text"]!.GetValue<string>() + next["text"]!.GetValue<string>();
                continue;
            }
            merged.Add(node);
        }
        return merged;
    }

    // ---------- comparing ----------

    /// <summary>
    /// The document in a fixed form for comparing: neighbouring text with the same formatting joined, formatting in
    /// name order, and empty paragraphs left out (they're only spacing).
    /// </summary>
    public static string Canonical(JsonElement doc) => Canon(doc)?.ToJsonString() ?? "";

    private static JsonObject? Canon(JsonElement node)
    {
        var type = TypeOf(node) ?? "";
        var output = new JsonObject { ["type"] = type };
        if (node.TryGetProperty("attrs", out var attrs) && attrs.ValueKind == JsonValueKind.Object)
        {
            var sorted = new JsonObject();
            foreach (var attr in attrs.EnumerateObject().OrderBy(a => a.Name, StringComparer.Ordinal))
                sorted[attr.Name] = JsonNode.Parse(attr.Value.GetRawText());
            if (sorted.Count > 0)
                output["attrs"] = sorted;
        }
        if (type == "text")
        {
            output["text"] = node.GetProperty("text").GetString();
            if (node.TryGetProperty("marks", out var marks) && marks.GetArrayLength() > 0)
                output["marks"] = new JsonArray([.. marks.EnumerateArray().OrderBy(m => TypeOf(m), StringComparer.Ordinal).Select(m => (JsonNode)Canon(m)!)]);
            return output;
        }
        var children = new List<JsonObject>();
        foreach (var child in Children(node))
        {
            if (IsEmptyParagraph(child))
                continue;
            var canon = Canon(child)!;
            if (children.Count > 0 && children[^1] is { } last && last["type"]!.GetValue<string>() == "text" && type != "codeBlock"
                && canon["type"]!.GetValue<string>() == "text" && JsonNode.DeepEquals(last["marks"], canon["marks"]))
            {
                last["text"] = last["text"]!.GetValue<string>() + canon["text"]!.GetValue<string>();
                continue;
            }
            children.Add(canon);
        }
        if (children.Count == 0 && type is "listItem" or "taskItem")
            children.Add(new JsonObject { ["type"] = "paragraph" });
        if (children.Count > 0)
            output["content"] = new JsonArray([.. children]);
        return output;
    }

    // ---------- reading nodes ----------

    private static string? TypeOf(JsonElement node) =>
        node.ValueKind == JsonValueKind.Object && node.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;

    private static JsonElement? Attr(JsonElement node, string name) =>
        node.TryGetProperty("attrs", out var attrs) && attrs.ValueKind == JsonValueKind.Object && attrs.TryGetProperty(name, out var value) ? value : null;

    private static IEnumerable<JsonElement> Children(JsonElement node) =>
        node.ValueKind == JsonValueKind.Object && node.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.Array ? c.EnumerateArray() : [];

    private static bool IsEmptyParagraph(JsonElement node) => TypeOf(node) == "paragraph" && !Children(node).Any();
}
