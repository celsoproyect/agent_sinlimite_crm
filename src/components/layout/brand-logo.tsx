"use client";

/* eslint-disable @next/next/no-img-element */

/**
 * The branding logo, swapped by color mode. Both images are rendered
 * and CSS (globals.css, `.brand-logo-*`) hides the one that doesn't
 * match `html[data-mode]`, so the switch is instant and there's no
 * flash before hydration. Without a light logo the single image is
 * shown in both modes.
 */
export function BrandLogo({
  logoUrl,
  logoLightUrl,
  alt,
  width,
  height,
  className,
}: {
  logoUrl: string;
  logoLightUrl: string | null;
  alt: string;
  width: number;
  height: number;
  className?: string;
}) {
  if (!logoLightUrl || logoLightUrl === logoUrl) {
    return (
      <img src={logoUrl} alt={alt} width={width} height={height} className={className} />
    );
  }
  return (
    <>
      <img
        src={logoUrl}
        alt={alt}
        width={width}
        height={height}
        className={`brand-logo-dark ${className ?? ""}`}
      />
      <img
        src={logoLightUrl}
        alt={alt}
        width={width}
        height={height}
        className={`brand-logo-light ${className ?? ""}`}
      />
    </>
  );
}
