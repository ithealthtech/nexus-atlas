using System.Globalization;
using Axe.Windows.Automation;
using Axe.Windows.Automation.Data;

// AccessibilityScan <process id> <page name>
// Scans the process's windows as they are now and prints one line per problem: the rule, then the element's type and
// name. The exit code is the number of problems (0 when there are none).
if (args.Length < 2 || !int.TryParse(args[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var processId))
{
    Console.Error.WriteLine("Usage: AccessibilityScan <process id> <page name>");
    return -1;
}

var page = args[1];
var config = Config.Builder.ForProcessId(processId).WithOutputFileFormat(OutputFileFormat.None).Build();
var scanner = ScannerFactory.CreateScanner(config);
var output = scanner.Scan(new ScanOptions(page, null));

var problems = 0;
foreach (var window in output.WindowScanOutputs)
{
    foreach (var error in window.Errors)
    {
        problems++;
        var element = error.Element;
        string Property(string name) => element?.Properties is { } p && p.TryGetValue(name, out var v) ? v : "";
        Console.WriteLine(string.Create(
            CultureInfo.InvariantCulture,
            $"{page}: {error.Rule.ID} ({error.Rule.Description}) on {Property("ControlType")} \"{Property("Name")}\" [{Property("AutomationId")}]"));
    }
}
Console.WriteLine(string.Create(CultureInfo.InvariantCulture, $"{page}: {problems} accessibility problem(s)."));
return problems;
