from PIL import Image, ImageDraw, ImageFont
import os

def generate_icon(size, filename):
    # Create an image with transparent background
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Draw a rounded rectangle or circle with gradient background
    # Since Pillow standard gradient is slightly complex, we can draw a nice colored circle
    margin = max(1, size // 16)
    
    # Outer glowing circle/rounded rect
    # Let's draw an outer circle with a nice neon purple color
    draw.ellipse([margin, margin, size - margin, size - margin], fill=(124, 58, 237, 255))
    
    # Inner circular accent
    inner_margin = margin + max(1, size // 8)
    draw.ellipse([inner_margin, inner_margin, size - inner_margin, size - inner_margin], fill=(15, 23, 42, 255))
    
    # Center text "AG"
    # To draw text, we can use a default font if custom font is not available, or draw some nice geometry.
    # Geometry is safer and cleaner if default fonts are not readable in small sizes.
    # Let's draw the letters A and G using simple lines/shapes for a modern look!
    # Or try loading a standard system font like Arial or Segoe UI.
    font = None
    try:
        # Try finding standard Windows fonts
        font_paths = [
            "C:\\Windows\\Fonts\\arialbd.ttf",
            "C:\\Windows\\Fonts\\segoeuib.ttf",
            "C:\\Windows\\Fonts\\tahomabd.ttf"
        ]
        for path in font_paths:
            if os.path.exists(path):
                font = ImageFont.truetype(path, int(size * 0.45))
                break
    except Exception:
        font = None
        
    if font:
        text = "AG"
        # Calculate text bounding box to center it
        bbox = draw.textbbox((0, 0), text, font=font)
        w = bbox[2] - bbox[0]
        h = bbox[3] - bbox[1]
        x = (size - w) // 2
        y = (size - h) // 2 - max(1, size // 16) # slight vertical adjustment
        draw.text((x, y), text, font=font, fill=(6, 182, 212, 255)) # Neon cyan color
    else:
        # Fallback: draw geometric shapes for "AG" if font load fails
        # Let's draw a triangle-like shape for A and a semicircle for G
        cx = size // 2
        cy = size // 2
        r = size // 4
        # Draw "A" left side
        draw.line([cx - r, cy + r, cx, cy - r], fill=(6, 182, 212, 255), width=max(1, size // 12))
        # Draw "A" right side
        draw.line([cx, cy - r, cx + r, cy + r], fill=(6, 182, 212, 255), width=max(1, size // 12))
        # Draw "A" crossbar
        draw.line([cx - r//2, cy, cx + r//2, cy], fill=(6, 182, 212, 255), width=max(1, size // 12))
        
    img.save(filename, 'PNG')
    print(f"Generated {filename}")

if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    generate_icon(16, 'icon16.png')
    generate_icon(48, 'icon48.png')
    generate_icon(128, 'icon128.png')
