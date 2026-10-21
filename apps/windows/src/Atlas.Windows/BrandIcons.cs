using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Atlas.Windows.Core;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace Atlas.Windows;

/// <summary>
/// The Atlas's own icon (its favicon) as this app's icon, saved beside the settings: an .ico with every size Windows
/// asks for (title bar, taskbar, tray, Start menu, at any display scale) and a 64-pixel PNG for the title bar. Each
/// picture gets its own file name, so Explorer's icon cache can't keep showing an old one.
/// </summary>
internal static class BrandIcons
{
    private static readonly int[] Sizes = [16, 20, 24, 32, 40, 48, 64, 256];

    /// <summary>Where the files go: the app's own folder, or a scratch folder for the preview.</summary>
    public static string Folder { get; set; } = SecureStore.DefaultFolder();

    /// <summary>The saved icon and title bar picture, if there is one.</summary>
    public static (string Icon, string Picture)? Saved()
    {
        if (!Directory.Exists(Folder))
            return null;
        var icon = Directory.EnumerateFiles(Folder, "icon-*.ico").FirstOrDefault();
        var picture = icon is null ? null : Path.ChangeExtension(icon, ".png");
        return icon is not null && File.Exists(picture) ? (icon, picture) : null;
    }

    /// <summary>Makes the icon files from the Atlas's picture (PNG or ICO). False if Windows can't read it.</summary>
    public static async Task<bool> SaveAsync(byte[] picture)
    {
        try
        {
            using var source = await StreamOf(picture);
            var decoder = await BitmapDecoder.CreateAsync(source);
            // An ICO holds several sizes: start from the biggest.
            uint best = 0, widest = 0;
            for (uint i = 0; i < decoder.FrameCount; i++)
            {
                var candidate = await decoder.GetFrameAsync(i);
                if (candidate.PixelWidth > widest)
                    (best, widest) = (i, candidate.PixelWidth);
            }
            var frame = await decoder.GetFrameAsync(best);
            var images = new List<IconImage>();
            byte[] titleBar = [];
            foreach (var size in Sizes)
            {
                var pixels = await PixelsAsync(frame, size);
                images.Add(size == 256 ? new IconImage(size, Png: await PngAsync(pixels, size)) : new IconImage(size, Bgra: pixels));
                if (size == 64)
                    titleBar = await PngAsync(pixels, size);
            }
            var stamp = Convert.ToHexString(SHA256.HashData(picture))[..12].ToLowerInvariant();
            Directory.CreateDirectory(Folder);
            Forget();
            await File.WriteAllBytesAsync(Path.Combine(Folder, $"icon-{stamp}.ico"), IconFile.Write(images));
            await File.WriteAllBytesAsync(Path.Combine(Folder, $"icon-{stamp}.png"), titleBar);
            return true;
        }
        catch (Exception e) when (e is COMException or ArgumentException or IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    /// <summary>Removes the saved icon files (best effort: one still open is removed next time).</summary>
    public static void Forget()
    {
        if (!Directory.Exists(Folder))
            return;
        foreach (var file in Directory.EnumerateFiles(Folder, "icon-*.*"))
        {
            try
            {
                File.Delete(file);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
            }
        }
    }

    private static async Task<byte[]> PixelsAsync(BitmapFrame frame, int size)
    {
        var transform = new BitmapTransform { ScaledWidth = (uint)size, ScaledHeight = (uint)size, InterpolationMode = BitmapInterpolationMode.Fant };
        var data = await frame.GetPixelDataAsync(
            BitmapPixelFormat.Bgra8, BitmapAlphaMode.Straight, transform, ExifOrientationMode.IgnoreExifOrientation, ColorManagementMode.DoNotColorManage);
        return data.DetachPixelData();
    }

    private static async Task<byte[]> PngAsync(byte[] pixels, int size)
    {
        using var output = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, output);
        encoder.SetPixelData(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Straight, (uint)size, (uint)size, 96, 96, pixels);
        await encoder.FlushAsync();
        return await BytesOf(output);
    }

    internal static async Task<InMemoryRandomAccessStream> StreamOf(byte[] bytes)
    {
        var stream = new InMemoryRandomAccessStream();
        using (var writer = new DataWriter(stream.GetOutputStreamAt(0)))
        {
            writer.WriteBytes(bytes);
            await writer.StoreAsync();
            await writer.FlushAsync();
            writer.DetachStream();
        }
        stream.Seek(0);
        return stream;
    }

    private static async Task<byte[]> BytesOf(IRandomAccessStream stream)
    {
        var bytes = new byte[stream.Size];
        using var reader = new DataReader(stream.GetInputStreamAt(0));
        await reader.LoadAsync((uint)stream.Size);
        reader.ReadBytes(bytes);
        return bytes;
    }
}
