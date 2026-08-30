import { Router } from 'express';
import { adminRouter } from './admin';
import { apiKeysRouter } from './apiKeys';
import { authRouter } from './auth';
import { jobsRouter } from './jobs';
import { projectsRouter } from './projects';
import { storageRouter } from './storage';
import { storyboardRouter } from './storyboard';
import { templatesRouter } from './templates';

export function buildRouter(): Router {
  const router = Router();

  router.use('/auth', authRouter);
  router.use('/projects', projectsRouter);
  // Storyboard endpoints are nested under a project so they inherit its id.
  router.use('/projects/:projectId', storyboardRouter);
  router.use('/api-keys', apiKeysRouter);
  router.use('/jobs', jobsRouter);
  router.use('/templates', templatesRouter);
  router.use('/admin', adminRouter);
  router.use('/', storageRouter);

  return router;
}
