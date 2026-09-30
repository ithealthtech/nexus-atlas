using System.Windows.Input;

namespace Atlas.Windows;

/// <summary>A command for tray menu items.</summary>
internal sealed class RelayCommand(Action run) : ICommand
{
    public event EventHandler? CanExecuteChanged
    {
        add { }
        remove { }
    }

    public bool CanExecute(object? parameter) => true;

    public void Execute(object? parameter) => run();
}
