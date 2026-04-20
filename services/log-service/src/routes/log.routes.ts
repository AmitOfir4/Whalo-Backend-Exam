import { Router } from 'express';
import { validate } from '@whalo/shared';
import { createLogSchema } from '../validators/log.validator';
import { createLog } from '../controllers/log.controller';

const router = Router();

router.post('/', validate(createLogSchema), createLog);

export default router;
