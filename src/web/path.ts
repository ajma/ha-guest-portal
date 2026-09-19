/**
 * Strips the base URI prefix from an href to get the application-level path.
 *
 * When served under a prefix like /api/hassio_ingress/TOKEN/, this function
 * extracts the application path by removing the base.
 *
 * @param baseUri - The base URI (from document.baseURI or <base href>)
 * @param href - The full URL to extract the path from
 * @returns The application path (e.g., '/admin' or '/')
 *
 * @example
 * appPath('http://host/', 'http://host/admin') → '/admin'
 * appPath('http://host/api/hassio_ingress/T/', 'http://host/api/hassio_ingress/T/admin') → '/admin'
 * appPath('http://host/prefix', 'http://host/prefix/admin') → '/admin'
 * appPath('http://host/', 'http://host/') → '/'
 */
export function appPath(baseUri: string, href: string): string {
  // Validate inputs
  if (!baseUri || !href) {
    return '/'
  }

  try {
    const base = new URL(baseUri).pathname.replace(/\/+$/, '') // "" or "/api/hassio_ingress/TOKEN"
    const path = new URL(href).pathname

    if (base !== '' && path.startsWith(base)) {
      return path.slice(base.length) || '/'
    }

    return path
  } catch {
    // Fallback for invalid URLs (e.g., in test environments)
    // Try to extract pathname directly if href looks like a path
    if (href.startsWith('/')) {
      return href
    }
    return '/'
  }
}
