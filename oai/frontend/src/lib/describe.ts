/** Shared by Describe Image and Image Cycles. */
export const DEFAULT_DESCRIBE_PROMPT = [
  'Describe this image in detail. Use the following rules:',
  '1. Describe main subject or person visually, do not use general words like "person", mention gender, age, body shape, skin color, race, hair, what person is wearing, pose, significant visual details.',
  '2. Describe what the subject is doing, what is going on around, what is on background.',
  '3. Describe atmosphere, dominant colors, lighting, weather, style.',
  '',
  'Write one paragraph, no numeration, 6 sentences max.',
].join('\n')

export const DESCRIBE_PROMPT_BUCKET = 'describe-image-user'

export const DEFAULT_IMPROVER_PROMPT =
  'Evaluate the visual quality of this image: composition, lighting, sharpness, anatomy, coherence, and visible artifacts. Give an honest quality score from 0 to 100 and a precise img2img prompt that fixes the most important defects while preserving the subject and composition.'
