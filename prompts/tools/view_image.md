View an image file (png, jpg, jpeg, webp) and return it as image content.

- Stay inside the workspace unless the user asks for a specific outside path; each outside path needs user approval.
- Only successful reads return image information; failures return an Error without image data.
- The file must match a supported format by content, not only by extension. Maximum {viewImageMaxBytes} bytes.
- Use this tool when the task requires seeing an image (screenshots, diagrams, UI). For text files use read instead.
- Only available when the current model accepts image input.