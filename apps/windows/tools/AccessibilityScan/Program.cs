using System.Globalization;
using Axe.Windows.Automation;
using Axe.Windows.Automation.Data;

// AccessibilityScan <process id> <page name> [rule:name ...]
// Scans the process's windows as they are now and prints one line per problem: the rule, then the element (its type,
// name, class, and where it is) and the element it's in. The exit code is the number of problems (0 when there are
// none). Each rule:name after the page name lets that rule pass for elements with that name: for words in made-up
// data, such as a client called "Harbor Dental Group" read as a group named "Group".
if (args.Length < 2 || !int.TryParse(args[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var processId))
{
    Console.Error.WriteLine("Usage: AccessibilityScan <process id> <page name> [rule:name ...]");
    return -1;
}

var page = args[1];
var allowed = args.Skip(2).ToHashSet(StringComparer.Ordinal);
var config = Config.Builder.ForProcessId(processId).WithOutputFileFormat(OutputFileFormat.None).Build();
var scanner = ScannerFactory.CreateScanner(config);
var output = scanner.Scan(new ScanOptions(page, null));

var problems = 0;
foreach (var window in output.WindowScanOutputs)
{
    foreach (var error in window.Errors)
    {
        var element = error.Element;
        static string Property(ElementInfo? of, string name) => of?.Properties is { } p && p.TryGetValue(name, out var v) ? v : "";
        if (allowed.Contains($"{error.Rule.ID}:{Property(element, "Name")}"))
            continue;
        // The Windows App SDK's own window for popups (tooltips, menus): once a popup has opened, the hidden host stays,
        // and its input window is as big as the app's. Nothing a person can reach; not the app's to fix.
        if (error.Rule.ID.ToString() == "BoundingRectangleCompletelyObscuresContainer"
            && Property(element, "ClassName") == "InputSiteWindowClass"
            && Property(element?.Parent, "ClassName") == "Microsoft.UI.Content.PopupWindowSiteBridge")
            continue;
        problems++;
        string Describe(ElementInfo? of) => of is null ? "nothing" : string.Create(
            CultureInfo.InvariantCulture,
            $"{Property(of, "ControlType")} \"{Property(of, "Name")}\" [{Property(of, "AutomationId")}] {Property(of, "ClassName")} at {Property(of, "BoundingRectangle")}");
        Console.WriteLine(string.Create(
            CultureInfo.InvariantCulture,
            $"{page}: {error.Rule.ID} ({error.Rule.Description}) on {Describe(element)}, in {Describe(element?.Parent)}"));
    }
}
Console.WriteLine(string.Create(CultureInfo.InvariantCulture, $"{page}: {problems} accessibility problem(s)."));
return problems;
