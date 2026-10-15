using System.Text.Json;
using Atlas.Windows.Core;
using Xunit;

namespace Atlas.Windows.Core.Tests;

public class DocumentTextTests
{
    private static JsonElement Doc(string blocks) => JsonDocument.Parse($$"""{"type":"doc","content":[{{blocks}}]}""").RootElement;

    private static string Paragraph(string text) =>
        """{"type":"paragraph","content":[{"type":"text","text":""" + JsonSerializer.Serialize(text) + "}]}";

    [Theory]
    [InlineData("Hello")]
    [InlineData("2 * 3 = 6, [x], a~b, a==b, `tick`, <u>tag</u>, ends=")]
    [InlineData(@"C:\Windows\System32 and \\server\share and a\*b and end\")]
    [InlineData("# not a heading")]
    [InlineData("- not a list")]
    [InlineData("1. not numbered, but 1.5 GHz is fine")]
    [InlineData("> not a quote")]
    [InlineData("---")]
    [InlineData("ends with a space ")]
    public void Plain_text_comes_back_unchanged(string text)
    {
        Assert.True(DocumentText.TryEditable(Doc(Paragraph(text)), out var written));
        var back = JsonSerializer.SerializeToElement(DocumentText.FromText(written));
        Assert.Equal(text, back.GetProperty("content")[0].GetProperty("content")[0].GetProperty("text").GetString());
    }

    [Fact]
    public void Formatting_is_written_the_way_people_type_it()
    {
        var doc = Doc("""
            {"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Steps"}]},
            {"type":"paragraph","content":[
              {"type":"text","text":"Run "},
              {"type":"text","text":"this","marks":[{"type":"bold"}]},
              {"type":"text","text":" with "},
              {"type":"text","text":"care","marks":[{"type":"bold"},{"type":"italic"}]},
              {"type":"text","text":", see "},
              {"type":"text","text":"the docs","marks":[{"type":"link","attrs":{"href":"https://example.com"}}]},
              {"type":"hardBreak"},
              {"type":"text","text":"Get-Service","marks":[{"type":"code"}]}
            ]},
            {"type":"orderedList","attrs":{"start":1},"content":[
              {"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"one"}]},
                {"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"inside"}]}]}]}]},
              {"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"two"}]}]}
            ]},
            {"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":true},"content":[{"type":"paragraph","content":[{"type":"text","text":"done"}]}]}]},
            {"type":"blockquote","content":[{"type":"paragraph","content":[{"type":"text","text":"careful"}]}]},
            {"type":"codeBlock","attrs":{"language":"powershell"},"content":[{"type":"text","text":"Restart-Service X\n  -Force"}]},
            {"type":"horizontalRule"}
            """);
        Assert.True(DocumentText.TryEditable(doc, out var text));
        Assert.Equal(
            "## Steps\n\nRun **this** with ***care***, see [the docs](https://example.com)\n`Get-Service`\n\n1. one\n\n  - inside\n2. two\n\n- [x] done\n\n> careful\n\n```powershell\nRestart-Service X\n  -Force\n```\n\n---",
            text);
    }

    [Fact]
    public void Typing_makes_the_same_document_the_web_editor_would()
    {
        var typed = DocumentText.FromText("# Printers\r\n\r\n1. Add the **queue**\r\n   then print\r\n- [ ] Tell Dana\r\n\r\nSee [portal](https://fw.test), and 5 * 3 stays a star.").ToJsonString();
        Assert.Contains("""{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Printers"}]}""", typed, StringComparison.Ordinal);
        Assert.Contains("""{"type":"orderedList","attrs":{"start":1}""", typed, StringComparison.Ordinal);
        Assert.Contains("""{"type":"text","text":"queue","marks":[{"type":"bold"}]},{"type":"hardBreak"},{"type":"text","text":" then print"}""", typed, StringComparison.Ordinal);
        Assert.Contains("""{"type":"taskItem","attrs":{"checked":false}""", typed, StringComparison.Ordinal);
        Assert.Contains("""{"type":"text","text":"portal","marks":[{"type":"link","attrs":{"href":"https://fw.test"}}]}""", typed, StringComparison.Ordinal);
        Assert.Contains("and 5 * 3 stays a star.", typed, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("""{"type":"table","content":[{"type":"tableRow","content":[{"type":"tableCell","attrs":{"colspan":1,"rowspan":1},"content":[{"type":"paragraph"}]}]}]}""")]
    [InlineData("""{"type":"paragraph","attrs":{"textAlign":"center"},"content":[{"type":"text","text":"centred"}]}""")]
    [InlineData("""{"type":"paragraph","content":[{"type":"text","text":"a`b","marks":[{"type":"code"}]}]}""")]
    [InlineData("""{"type":"paragraph","content":[{"type":"text","text":"  indented"}]}""")]
    public void Content_text_cant_hold_keeps_the_document_locked(string block) =>
        Assert.False(DocumentText.TryEditable(Doc(block), out _));

    [Fact]
    public void Empty_paragraphs_are_only_spacing() =>
        Assert.True(DocumentText.TryEditable(Doc(Paragraph("a") + """,{"type":"paragraph"},""" + Paragraph("b")), out _));
}
