using System.Security.Authentication;

namespace Atlas.Windows.Core;

/// <summary>Says why Atlas couldn't be reached, in words someone can act on.</summary>
public static class ConnectionProblem
{
    /// <summary>
    /// A certificate this computer doesn't trust gets its own message: the app has no way to accept one, so the
    /// person needs to know that's the reason, not that Atlas is down.
    /// </summary>
    public static string Describe(HttpRequestException error)
    {
        ArgumentNullException.ThrowIfNull(error);
        for (Exception? cause = error; cause is not null; cause = cause.InnerException)
        {
            if (cause is AuthenticationException)
                return "This computer doesn't trust Atlas's certificate, so Atlas for Windows won't connect. "
                    + "Use the address the certificate was issued for, or ask your administrator to have this computer trust it.";
        }
        return "Atlas could not be reached. Check the address and your connection.";
    }
}
