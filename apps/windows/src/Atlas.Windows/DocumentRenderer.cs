using Atlas.Windows.Core;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;
using FontStyle = Windows.UI.Text.FontStyle;
using TextDecorations = Windows.UI.Text.TextDecorations;

namespace Atlas.Windows;

/// <summary>
/// Draws a document (<see cref="DocumentView"/>) the way it looks in Atlas: headings, paragraphs with their
/// formatting and links, lists and checklists, quotes, code with a copy button, lines, and tables. Text can be
/// selected; links open in the browser, and links to Atlas pages open on this Atlas.
/// </summary>
internal sealed class DocumentRenderer(Uri? atlas, Action<string> copyCode)
{
    private static readonly FontFamily Mono = new("Cascadia Mono, Consolas");
    private static readonly string[] Bullets = ["•", "◦", "▪"];
    // Highlighted text: a soft amber that reads in light and dark themes.
    private readonly Brush marker = new SolidColorBrush(Microsoft.UI.ColorHelper.FromArgb(0x70, 0xFF, 0xC4, 0x2E));

    /// <summary>What blocks inherit from what they're in: muted text in a quote, bold in a table heading, list depth.</summary>
    private readonly record struct Ink(Brush? Foreground = null, bool Strong = false, int Depth = 0);

    public UIElement Render(IReadOnlyList<DocBlock> blocks)
    {
        var panel = Blocks(blocks, new Ink(), spacing: 10);
        panel.Padding = new Thickness(16, 14, 16, 16);
        return panel;
    }

    private StackPanel Blocks(IReadOnlyList<DocBlock> blocks, Ink ink, double spacing)
    {
        var panel = new StackPanel { Spacing = spacing };
        for (var i = 0; i < blocks.Count; i++)
        {
            var element = Block(blocks[i], ink);
            // A heading after other text gets room above it, so sections read as sections.
            if (i > 0 && blocks[i] is DocHeading && element is FrameworkElement heading)
                heading.Margin = new Thickness(0, 8, 0, 0);
            panel.Children.Add(element);
        }
        return panel;
    }

    private UIElement Block(DocBlock block, Ink ink) => block switch
    {
        DocParagraph p => Text(p.Runs, p.Align, ink),
        DocHeading h => Heading(h, ink),
        DocList list => List(list, ink),
        DocQuote quote => Quote(quote, ink),
        DocCode code => Code(code),
        DocRule => new Border { Height = 1, Margin = new Thickness(0, 6, 0, 6), Background = Resource("DividerStrokeColorDefaultBrush") },
        DocTable table => Table(table, ink),
        DocGroup group => Blocks(group.Blocks, ink, 10),
        _ => new StackPanel(),
    };

    // ---------- text ----------
    private RichTextBlock Heading(DocHeading heading, Ink ink)
    {
        var text = Text(heading.Runs, heading.Align, ink);
        text.FontSize = heading.Level switch { 1 => 24, 2 => 20, 3 => 17, _ => 15 };
        text.FontWeight = FontWeights.SemiBold;
        text.LineHeight = 0;
        // Named, so a screen reader's list of headings shows the words.
        AutomationProperties.SetName(text, string.Concat(heading.Runs.Select(r => r.Text)).Trim());
        AutomationProperties.SetHeadingLevel(text, heading.Level switch
        {
            1 => AutomationHeadingLevel.Level1,
            2 => AutomationHeadingLevel.Level2,
            3 => AutomationHeadingLevel.Level3,
            _ => AutomationHeadingLevel.Level4,
        });
        return text;
    }

    private RichTextBlock Text(IReadOnlyList<DocRun> runs, DocAlign align, Ink ink)
    {
        var block = new RichTextBlock
        {
            IsTextSelectionEnabled = true,
            TextWrapping = TextWrapping.Wrap,
            LineHeight = 22,
            TextAlignment = align switch
            {
                DocAlign.Center => TextAlignment.Center,
                DocAlign.End => TextAlignment.Right,
                DocAlign.Justify => TextAlignment.Justify,
                _ => TextAlignment.Left,
            },
        };
        if (ink.Foreground is { } foreground)
            block.Foreground = foreground;
        if (ink.Strong)
            block.FontWeight = FontWeights.SemiBold;

        var paragraph = new Paragraph();
        var marked = new TextHighlighter { Background = marker, Foreground = Resource("TextFillColorPrimaryBrush") };
        var code = new TextHighlighter { Background = Resource("SubtleFillColorSecondaryBrush"), Foreground = Resource("TextFillColorPrimaryBrush") };
        // Highlights are drawn over ranges of characters, so count them as the runs go in. A line break is one.
        var at = 0;
        for (var i = 0; i < runs.Count;)
        {
            var link = runs[i].Link;
            var inlines = paragraph.Inlines;
            Hyperlink? hyperlink = null;
            if (link is not null && LinkTarget(link) is { } target)
            {
                hyperlink = new Hyperlink { NavigateUri = target };
                ToolTipService.SetToolTip(hyperlink, target.ToString());
                inlines = hyperlink.Inlines;
            }
            // Runs with the same link go in one hyperlink.
            do
            {
                var run = runs[i];
                if (run.Text == "\n")
                {
                    inlines.Add(new LineBreak());
                    at += 1;
                }
                else
                {
                    inlines.Add(Run(run));
                    if (run.Marks.HasFlag(DocMarks.Highlight))
                        marked.Ranges.Add(new TextRange { StartIndex = at, Length = run.Text.Length });
                    else if (run.Marks.HasFlag(DocMarks.Code))
                        code.Ranges.Add(new TextRange { StartIndex = at, Length = run.Text.Length });
                    at += run.Text.Length;
                }
                i++;
            }
            while (i < runs.Count && runs[i].Link == link && link is not null);
            if (hyperlink is not null)
                paragraph.Inlines.Add(hyperlink);
        }
        block.Blocks.Add(paragraph);
        if (code.Ranges.Count > 0)
            block.TextHighlighters.Add(code);
        if (marked.Ranges.Count > 0)
            block.TextHighlighters.Add(marked);
        return block;
    }

    private static Run Run(DocRun run)
    {
        var inline = new Run { Text = run.Text };
        if (run.Marks.HasFlag(DocMarks.Bold))
            inline.FontWeight = FontWeights.SemiBold;
        if (run.Marks.HasFlag(DocMarks.Italic))
            inline.FontStyle = FontStyle.Italic;
        var decorations = TextDecorations.None;
        if (run.Marks.HasFlag(DocMarks.Underline))
            decorations |= TextDecorations.Underline;
        if (run.Marks.HasFlag(DocMarks.Strike))
            decorations |= TextDecorations.Strikethrough;
        inline.TextDecorations = decorations;
        if (run.Marks.HasFlag(DocMarks.Code))
            inline.FontFamily = Mono;
        return inline;
    }

    /// <summary>Where a link goes: web, mail, and phone links as they are, and a path in Atlas on this Atlas.</summary>
    private Uri? LinkTarget(string link)
    {
        if (link.StartsWith('/'))
            return atlas is null ? null : new Uri(atlas, link);
        return Uri.TryCreate(link, UriKind.Absolute, out var uri) ? uri : null;
    }

    // ---------- lists and quotes ----------
    private Grid List(DocList list, Ink ink)
    {
        var grid = new Grid { ColumnSpacing = 8, RowSpacing = 6 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var number = list.Start;
        var inner = ink with { Depth = ink.Depth + 1 };
        for (var row = 0; row < list.Items.Count; row++)
        {
            var item = list.Items[row];
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            FrameworkElement marker = list.Kind switch
            {
                DocListKind.Checklist => Check(item.Done == true),
                DocListKind.Numbers => MarkerText($"{number++}.", ink),
                _ => MarkerText(Bullets[ink.Depth % Bullets.Length], ink),
            };
            // Numbers line up on their right, so 9. and 10. end in the same place.
            marker.MinWidth = list.Kind == DocListKind.Numbers ? 20 : 14;
            Grid.SetRow(marker, row);
            grid.Children.Add(marker);

            var content = Blocks(item.Blocks, item.Done == true ? inner with { Foreground = Resource("TextFillColorSecondaryBrush") } : inner, 6);
            Grid.SetRow(content, row);
            Grid.SetColumn(content, 1);
            grid.Children.Add(content);
        }
        return grid;
    }

    private static TextBlock MarkerText(string text, Ink ink) => new()
    {
        Text = text,
        LineHeight = 22,
        TextAlignment = TextAlignment.Right,
        Foreground = ink.Foreground ?? Resource("TextFillColorSecondaryBrush"),
    };

    private static FontIcon Check(bool done)
    {
        var icon = new FontIcon
        {
            Glyph = done ? "" : "",
            FontSize = 16,
            Margin = new Thickness(0, 3, 0, 0),
            VerticalAlignment = VerticalAlignment.Top,
            Foreground = done ? Resource("AccentTextFillColorPrimaryBrush") : Resource("TextFillColorSecondaryBrush"),
        };
        AutomationProperties.SetName(icon, done ? "Done" : "Not done");
        return icon;
    }

    private Border Quote(DocQuote quote, Ink ink) => new()
    {
        BorderBrush = Resource("ControlStrongStrokeColorDefaultBrush"),
        BorderThickness = new Thickness(3, 0, 0, 0),
        Padding = new Thickness(12, 2, 0, 2),
        Child = Blocks(quote.Blocks, ink with { Foreground = Resource("TextFillColorSecondaryBrush") }, 8),
    };

    // ---------- code ----------
    private Border Code(DocCode code)
    {
        var grid = new Grid();
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        var bar = new Grid { Padding = new Thickness(12, 2, 2, 0) };
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        bar.Children.Add(new TextBlock
        {
            Text = code.Language ?? "Code",
            FontSize = 12,
            VerticalAlignment = VerticalAlignment.Center,
            Foreground = Resource("TextFillColorSecondaryBrush"),
        });
        var copy = new Button
        {
            Padding = new Thickness(8, 4, 8, 4),
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            BorderThickness = new Thickness(0),
            Content = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Spacing = 6,
                Children =
                {
                    new FontIcon { Glyph = "", FontSize = 12 },
                    new TextBlock { Text = "Copy", FontSize = 12 },
                },
            },
        };
        AutomationProperties.SetName(copy, "Copy code");
        ToolTipService.SetToolTip(copy, "Copy code");
        copy.Click += (_, _) => copyCode(code.Text);
        Grid.SetColumn(copy, 1);
        bar.Children.Add(copy);
        grid.Children.Add(bar);

        var scroller = new ScrollViewer
        {
            HorizontalScrollMode = ScrollMode.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            VerticalScrollMode = ScrollMode.Disabled,
            VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Content = new TextBlock
            {
                Text = code.Text,
                FontFamily = Mono,
                FontSize = 13,
                LineHeight = 20,
                IsTextSelectionEnabled = true,
                TextWrapping = TextWrapping.NoWrap,
                Padding = new Thickness(12, 2, 12, 12),
            },
        };
        Grid.SetRow(scroller, 1);
        grid.Children.Add(scroller);

        return new Border
        {
            Background = Resource("SubtleFillColorSecondaryBrush"),
            BorderBrush = Resource("CardStrokeColorDefaultBrush"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(6),
            Child = grid,
        };
    }

    // ---------- tables ----------
    private ScrollViewer Table(DocTable table, Ink ink)
    {
        var grid = new Grid();
        // Where each cell goes, leaving room for cells that span rows above.
        var taken = new HashSet<(int Row, int Column)>();
        var columns = 0;
        for (var r = 0; r < table.Rows.Count; r++)
        {
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var c = 0;
            foreach (var cell in table.Rows[r].Cells)
            {
                while (taken.Contains((r, c)))
                    c++;
                for (var dr = 0; dr < cell.RowSpan; dr++)
                    for (var dc = 0; dc < cell.ColumnSpan; dc++)
                        taken.Add((r + dr, c + dc));

                var border = new Border
                {
                    BorderBrush = Resource("CardStrokeColorDefaultBrush"),
                    BorderThickness = new Thickness(0, 0, 1, 1),
                    Padding = new Thickness(10, 6, 10, 6),
                    MinWidth = 60,
                    MaxWidth = 320 * cell.ColumnSpan,
                    Background = cell.Header ? Resource("SubtleFillColorSecondaryBrush") : null,
                    Child = Blocks(cell.Blocks, cell.Header ? ink with { Strong = true } : ink, 6),
                };
                Grid.SetRow(border, r);
                Grid.SetColumn(border, c);
                Grid.SetRowSpan(border, cell.RowSpan);
                Grid.SetColumnSpan(border, cell.ColumnSpan);
                grid.Children.Add(border);
                c += cell.ColumnSpan;
                columns = Math.Max(columns, c);
            }
        }
        // A cell spanning rows past the last one still needs those rows.
        var rows = taken.Count == 0 ? 0 : taken.Max(t => t.Row) + 1;
        while (grid.RowDefinitions.Count < rows)
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        for (var i = 0; i < columns; i++)
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        return new ScrollViewer
        {
            HorizontalScrollMode = ScrollMode.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            VerticalScrollMode = ScrollMode.Disabled,
            VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Content = new Border
            {
                BorderBrush = Resource("CardStrokeColorDefaultBrush"),
                BorderThickness = new Thickness(1, 1, 0, 0),
                CornerRadius = new CornerRadius(4),
                HorizontalAlignment = HorizontalAlignment.Left,
                Child = grid,
            },
        };
    }

    private static Brush Resource(string key) => Themed.Brush(key);
}
