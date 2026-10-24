import { Router } from 'express';
import { z } from 'zod';

import { HttpError } from '../errors/httpError.js';
import { speechRateLimit } from '../middleware/rateLimit.js';
import { membershipService } from '../services/membershipService.js';
import { openSpeech } from '../services/speechService.js';

const workspaceIdSchema = z.string().uuid();
const speakSchema = z
  .object({
    text: z.string().trim().min(2).max(4_000),
    voiceId: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export const speechRouter = Router();
speechRouter.use(speechRateLimit);

speechRouter.post('/workspaces/:workspaceId/speech', async (request, response, next) => {
  try {
    const userId = request.authUser?.sub;
    if (!userId) {
      throw new HttpError(401, 'Authentication is required.');
    }

    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    const { text, voiceId } = speakSchema.parse(request.body);
    await membershipService.requireMember(workspaceId, userId);
    const audio = await openSpeech(text, voiceId);
    response.status(200);
    response.setHeader('Content-Type', 'audio/wav');
    response.setHeader('Cache-Control', 'no-store');
    const reader = audio.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) response.write(Buffer.from(value));
    }
    response.end();
  } catch (error) {
    next(error);
  }
});
