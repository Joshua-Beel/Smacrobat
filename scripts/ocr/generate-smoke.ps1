[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (Test-Path -LiteralPath $OutputPath) {
    throw "Smoke output already exists: $OutputPath"
}
$parent = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    throw "Smoke output parent does not exist: $parent"
}

Add-Type -AssemblyName System.Drawing
$width = 1200
$height = 240
$bitmap = [Drawing.Bitmap]::new($width, $height, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$font = [Drawing.Font]::new('Arial', 28, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Point)
$brush = [Drawing.SolidBrush]::new([Drawing.Color]::Black)
try {
    if ($font.Name -ne 'Arial') {
        throw "Arial is unavailable; System.Drawing substituted '$($font.Name)'."
    }
    $graphics.Clear([Drawing.Color]::White)
    $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $graphics.DrawString('Receipt #A-17: Coffee & Tea, $12.50.', $font, $brush, 72, 72)
    $graphics.DrawString('Mixed case: 3rd Avenue; ready.', $font, $brush, 72, 132)

    $stream = [IO.File]::Open($OutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $header = [Text.Encoding]::ASCII.GetBytes("P6`n$width $height`n255`n")
        $stream.Write($header, 0, $header.Length)
        $rgb = [byte[]]::new(3)
        for ($y = 0; $y -lt $height; $y++) {
            for ($x = 0; $x -lt $width; $x++) {
                $color = $bitmap.GetPixel($x, $y)
                $rgb[0] = $color.R
                $rgb[1] = $color.G
                $rgb[2] = $color.B
                $stream.Write($rgb, 0, 3)
            }
        }
        $stream.Flush($true)
    } finally {
        $stream.Dispose()
    }
} finally {
    $brush.Dispose()
    $font.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}

[ordered]@{
    path = $OutputPath
    width = $width
    height = $height
    font = 'Arial 28pt rendered by System.Drawing; no font file is copied or redistributed'
    expectedText = "Receipt #A-17: Coffee & Tea, `$12.50.`nMixed case: 3rd Avenue; ready."
}
