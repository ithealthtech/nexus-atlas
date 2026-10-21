using System.Text.Json;
using Atlas.Windows.Core;
using Xunit;

namespace Atlas.Windows.Core.Tests;

public class DocumentViewTests
{
    private static IReadOnlyList<DocBlock> Parse(string blocks) =>
        DocumentView.Parse(JsonDocument.Parse($$"""{"type":"doc","content":[{{blocks}}]}""").RootElement);

    [Fact]
    public void Headings_and_paragraphs_keep_their_formatting()
    {
        var blocks = Parse("""
            {"type":"heading","attrs":{"level":3},"content":[{"type":"text","text":"Steps"}]},
            {"type":"paragraph","attrs":{"textAlign":"center"},"content":[
              {"type":"text","text":"Run "},
              {"type":"text","text":"this","marks":[{"type":"bold"},{"type":"italic"}]},
              {"type":"text","text":" now","marks":[{"type":"highlight"}]},
              {"type":"hardBreak"},
              {"type":"text","text":"Get-Service","marks":[{"type":"code"}]},
              {"type":"text","text":" and ","marks":[{"type":"underline"}]},
              {"type":"text","text":"not this","marks":[{"type":"strike"}]}
            ]}
            """);

        var heading = Assert.IsType<DocHeading>(blocks[0]);
        Assert.Equal(3, heading.Level);
        Assert.Equal("Steps", Assert.Single(heading.Runs).Text);

        var paragraph = Assert.IsType<DocParagraph>(blocks[1]);
        Assert.Equal(DocAlign.Center, paragraph.Align);
        Assert.Equal<DocRun>(
            [
                new DocRun("Run ", DocMarks.None, null),
                new DocRun("this", DocMarks.Bold | DocMarks.Italic, null),
                new DocRun(" now", DocMarks.Highlight, null),
                new DocRun("\n", DocMarks.None, null),
                new DocRun("Get-Service", DocMarks.Code, null),
                new DocRun(" and ", DocMarks.Underline, null),
                new DocRun("not this", DocMarks.Strike, null),
            ],
            paragraph.Runs);
    }

    [Fact]
    public void Text_with_the_same_formatting_is_one_run()
    {
        var blocks = Parse("""
            {"type":"paragraph","content":[{"type":"text","text":"one "},{"type":"text","text":"two"}]}
            """);
        Assert.Equal("one two", Assert.Single(Assert.IsType<DocParagraph>(blocks[0]).Runs).Text);
    }

    [Theory]
    [InlineData("https://portal.example.com/a?b=1", "https://portal.example.com/a?b=1")]
    [InlineData("mailto:help@example.com", "mailto:help@example.com")]
    [InlineData("tel:+19195550142", "tel:+19195550142")]
    [InlineData("/clients/c1/assets/a1", "/clients/c1/assets/a1")]
    [InlineData("//evil.example.com", null)]
    [InlineData("javascript:alert(1)", null)]
    [InlineData("file:///C:/Windows/System32/calc.exe", null)]
    [InlineData("", null)]
    public void Only_safe_links_are_kept(string href, string? expected)
    {
        var blocks = Parse($$$"""
            {"type":"paragraph","content":[{"type":"text","text":"link","marks":[{"type":"link","attrs":{"href":{{{JsonSerializer.Serialize(href)}}}}}]}]}
            """);
        Assert.Equal(expected, Assert.Single(Assert.IsType<DocParagraph>(blocks[0]).Runs).Link);
    }

    [Fact]
    public void Lists_number_from_their_start_and_checklists_say_what_is_done()
    {
        var blocks = Parse("""
            {"type":"orderedList","attrs":{"start":4},"content":[
              {"type":"listItem","content":[
                {"type":"paragraph","content":[{"type":"text","text":"Four"}]},
                {"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Under four"}]}]}]}
              ]}
            ]},
            {"type":"taskList","content":[
              {"type":"taskItem","attrs":{"checked":true},"content":[{"type":"paragraph","content":[{"type":"text","text":"Backup checked"}]}]},
              {"type":"taskItem","attrs":{"checked":false},"content":[{"type":"paragraph","content":[{"type":"text","text":"Tell Dana"}]}]}
            ]}
            """);

        var numbers = Assert.IsType<DocList>(blocks[0]);
        Assert.Equal(DocListKind.Numbers, numbers.Kind);
        Assert.Equal(4, numbers.Start);
        var item = Assert.Single(numbers.Items);
        Assert.Null(item.Done);
        Assert.IsType<DocParagraph>(item.Blocks[0]);
        Assert.Equal(DocListKind.Bullets, Assert.IsType<DocList>(item.Blocks[1]).Kind);

        var checklist = Assert.IsType<DocList>(blocks[1]);
        Assert.Equal(DocListKind.Checklist, checklist.Kind);
        Assert.Equal<bool?>([true, false], checklist.Items.Select(i => i.Done));
    }

    [Fact]
    public void Quotes_code_lines_and_tables()
    {
        var blocks = Parse("""
            {"type":"blockquote","content":[{"type":"paragraph","content":[{"type":"text","text":"Never reboot before 6 PM."}]}]},
            {"type":"codeBlock","attrs":{"language":"powershell"},"content":[{"type":"text","text":"Restart-Service Spooler\nGet-Service Spooler"}]},
            {"type":"horizontalRule"},
            {"type":"table","content":[
              {"type":"tableRow","content":[
                {"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"VLAN"}]}]},
                {"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"Use"}]}]}
              ]},
              {"type":"tableRow","content":[
                {"type":"tableCell","attrs":{"colspan":2,"rowspan":1},"content":[{"type":"paragraph","content":[{"type":"text","text":"10 - Data"}]}]}
              ]}
            ]}
            """);

        Assert.IsType<DocParagraph>(Assert.Single(Assert.IsType<DocQuote>(blocks[0]).Blocks));
        var code = Assert.IsType<DocCode>(blocks[1]);
        Assert.Equal("Restart-Service Spooler\nGet-Service Spooler", code.Text);
        Assert.Equal("powershell", code.Language);
        Assert.IsType<DocRule>(blocks[2]);
        var table = Assert.IsType<DocTable>(blocks[3]);
        Assert.Equal(2, table.Rows.Count);
        Assert.All(table.Rows[0].Cells, c => Assert.True(c.Header));
        var wide = Assert.Single(table.Rows[1].Cells);
        Assert.False(wide.Header);
        Assert.Equal(2, wide.ColumnSpan);
        Assert.Equal(1, wide.RowSpan);
    }

    [Fact]
    public void Nothing_unknown_is_lost()
    {
        var blocks = Parse("""
            {"type":"callout","content":[{"type":"text","text":"Read me first"}]},
            {"type":"details","content":[{"type":"paragraph","content":[{"type":"text","text":"Inside"}]},{"type":"paragraph","content":[{"type":"text","text":"Both"}]}]},
            {"type":"paragraph","content":[{"type":"mention","content":[{"type":"text","text":"@Dana"}]}]}
            """);

        Assert.Equal("Read me first", Assert.Single(Assert.IsType<DocParagraph>(blocks[0]).Runs).Text);
        Assert.Equal(2, Assert.IsType<DocGroup>(blocks[1]).Blocks.Count);
        Assert.Equal("@Dana", Assert.Single(Assert.IsType<DocParagraph>(blocks[2]).Runs).Text);
    }

    [Fact]
    public async Task The_preview_has_a_document_with_every_kind_of_block()
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = new AtlasClient(PreviewServer.Address, new PreviewServer());
        client.UseToken(PreviewServer.Token);
        var blocks = DocumentView.Parse((await client.GetDocumentAsync("d-onboard", ct)).Content);
        var kinds = blocks.Select(b => b.GetType()).ToHashSet();
        Type[] every = [typeof(DocParagraph), typeof(DocQuote), typeof(DocHeading), typeof(DocList), typeof(DocCode), typeof(DocTable), typeof(DocRule)];
        Assert.All(every, kind => Assert.Contains(kind, kinds));
        Assert.Equal([DocListKind.Checklist, DocListKind.Numbers], blocks.OfType<DocList>().Select(l => l.Kind));
        // The reboot procedure stays editable as text: tables can't be.
        Assert.True(DocumentText.TryEditable((await client.GetDocumentAsync("d-reboot", ct)).Content, out _));
    }

    [Fact]
    public void Empty_and_odd_documents()
    {
        Assert.True(DocumentView.IsEmpty(Parse("""{"type":"paragraph"}""")));
        Assert.Empty(DocumentView.Parse(JsonDocument.Parse("""{"type":"doc"}""").RootElement));
        Assert.Empty(DocumentView.Parse(JsonDocument.Parse("[1,2]").RootElement));
        Assert.False(DocumentView.IsEmpty(Parse("""{"type":"horizontalRule"}""")));
    }
}
