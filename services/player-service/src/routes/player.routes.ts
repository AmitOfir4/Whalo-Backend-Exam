import { Router } from 'express';
import { validate, validateQuery } from '@whalo/shared';
import { createPlayerSchema, updatePlayerSchema, listPlayersQuerySchema } from '../validators/player.validator';
import {
  createPlayer,
  getAllPlayers,
  getPlayer,
  updatePlayer,
  deletePlayer,
} from '../controllers/player.controller';

const router = Router();

router.post('/', validate(createPlayerSchema), createPlayer);
router.get('/', validateQuery(listPlayersQuerySchema), getAllPlayers);
router.get('/:playerId', getPlayer);
router.put('/:playerId', validate(updatePlayerSchema), updatePlayer);
router.delete('/:playerId', deletePlayer);

export default router;
