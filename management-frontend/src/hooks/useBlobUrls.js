import { useEffect, useRef } from 'react';

/**
 * Hook to manage blob URL lifecycle. Returns a ref whose `.current` is an array
 * of blob URLs. All URLs are revoked on unmount.
 *
 * Call `revokeAll()` before replacing the array to avoid memory leaks.
 */
export function useBlobUrls() {
  const blobUrlsRef = useRef([]);

  useEffect(() => {
    return () => { blobUrlsRef.current.forEach(URL.revokeObjectURL); };
  }, []);

  const revokeAll = () => {
    blobUrlsRef.current.forEach(URL.revokeObjectURL);
    blobUrlsRef.current = [];
  };

  const track = (url) => {
    blobUrlsRef.current.push(url);
  };

  return { blobUrlsRef, revokeAll, track };
}
