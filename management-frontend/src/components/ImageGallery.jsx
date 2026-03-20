import React from 'react';
import { sandboxStyles as ss } from '../sandboxStyles';

/**
 * Renders a grid of generated images with download links and optional lightbox trigger.
 *
 * @param {object} props
 * @param {Array} props.images - Array of image objects with blobUrl/data_base64, filename, content_type
 * @param {function} [props.onImageClick] - Called with the image src URL for lightbox
 */
const ImageGallery = ({ images, onImageClick }) => {
  if (!images || images.length === 0) return null;

  return (
    <div style={ss.imageGrid}>
      {images.map((img, idx) => {
        const src = img.blobUrl
          ?? (img.data_base64 ? `data:${img.content_type};base64,${img.data_base64}` : null);
        return (
          <div key={idx}>
            <img
              src={src}
              alt={`Generated ${idx + 1}`}
              style={ss.image}
              onClick={() => onImageClick?.(src)}
            />
            <div style={ss.imageFooter}>
              <p style={ss.imageName}>{img.filename}</p>
              <a href={src} download={img.filename} style={ss.downloadLink}>
                Download
              </a>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default ImageGallery;
