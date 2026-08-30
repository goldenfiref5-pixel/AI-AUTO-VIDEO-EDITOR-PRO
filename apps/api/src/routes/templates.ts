import { Router } from 'express';
import { z } from 'zod';
import { TEMPLATE_KINDS, templateSchema } from '@aiedit/shared';
import { authContext, requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  requireTemplate,
  updateTemplate,
} from '../services/templates';
import { requireProject, updateProject } from '../services/projects';
import { getStyleDna, upsertStyleDna } from '../services/styleProfiles';
import { badRequest } from '../utils/errors';
import type { StyleDnaDraft } from '../pipeline/styleDna';

export const templatesRouter = Router();

templatesRouter.use(requireAuth);

templatesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { userId } = authContext(req);
    const kind = typeof req.query['kind'] === 'string' ? req.query['kind'] : undefined;
    if (kind && !(TEMPLATE_KINDS as readonly string[]).includes(kind)) {
      throw badRequest(`Unknown template kind "${kind}".`);
    }
    res.json({ templates: await listTemplates(userId, kind as never) });
  }),
);

templatesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { userId } = authContext(req);
    const input = templateSchema.parse(req.body);
    res.status(201).json({ template: await createTemplate({ userId, ...input }) });
  }),
);

templatesRouter.patch(
  '/:templateId',
  asyncHandler(async (req, res) => {
    const { userId } = authContext(req);
    const input = templateSchema.partial().parse(req.body);
    res.json({
      template: await updateTemplate(req.params['templateId']!, userId, {
        name: input.name,
        description: input.description,
        payload: input.payload,
      }),
    });
  }),
);

templatesRouter.delete(
  '/:templateId',
  asyncHandler(async (req, res) => {
    const { userId } = authContext(req);
    await deleteTemplate(req.params['templateId']!, userId);
    res.status(204).end();
  }),
);

const applySchema = z.object({ projectId: z.string().uuid() });

/** Apply a saved template to a project. */
templatesRouter.post(
  '/:templateId/apply',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const template = await requireTemplate(req.params['templateId']!, userId);
    const { projectId } = applySchema.parse(req.body);
    const project = await requireProject(projectId, userId, isAdmin);

    switch (template.kind) {
      case 'style_dna': {
        const draft = template.payload as unknown as StyleDnaDraft;
        await upsertStyleDna(project.id, { ...draft, sourceAssetIds: [] });
        break;
      }
      case 'caption_preset':
        await updateProject(project, { settings: { caption: template.payload as never } });
        break;
      case 'export_preset':
        await updateProject(project, { settings: { export: template.payload as never } });
        break;
      case 'video_template':
        // A video template bundles every project-level setting at once.
        await updateProject(project, { settings: template.payload as never });
        break;
      case 'character':
        throw badRequest(
          'Character templates are applied from the storyboard screen, where they attach to a specific role.',
        );
    }

    res.json({
      project: await requireProject(project.id, userId, isAdmin),
      styleDna: await getStyleDna(project.id),
    });
  }),
);

const saveFromProjectSchema = z.object({
  projectId: z.string().uuid(),
  kind: z.enum(TEMPLATE_KINDS),
  name: z.string().min(1).max(160),
  description: z.string().max(1000).optional(),
});

/** Capture the current project configuration as a reusable template. */
templatesRouter.post(
  '/from-project',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const input = saveFromProjectSchema.parse(req.body);
    const project = await requireProject(input.projectId, userId, isAdmin);

    let payload: Record<string, unknown>;
    switch (input.kind) {
      case 'style_dna': {
        const dna = await getStyleDna(project.id);
        if (!dna) throw badRequest('This project has no Style DNA to save yet.');
        const { id, projectId, createdAt, ...rest } = dna;
        payload = rest as unknown as Record<string, unknown>;
        break;
      }
      case 'caption_preset':
        payload = project.settings.caption as unknown as Record<string, unknown>;
        break;
      case 'export_preset':
        payload = project.settings.export as unknown as Record<string, unknown>;
        break;
      case 'video_template':
        payload = project.settings as unknown as Record<string, unknown>;
        break;
      case 'character':
        throw badRequest('Save a character template from the character panel instead.');
    }

    res.status(201).json({
      template: await createTemplate({
        userId,
        kind: input.kind,
        name: input.name,
        description: input.description ?? null,
        payload,
      }),
    });
  }),
);
