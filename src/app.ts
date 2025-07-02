import { CacheService } from './services/cache.service';
import { CronService } from './services/cron.service';
import { DBService } from './services/db.service';
import { IntentsService } from './services/intents.service';
import { NearService } from './services/near.service';
import { QuoterService } from './services/quoter.service';
import { StateManagerService } from './services/state-manager.service';
import { HttpService } from './services/http.service';
import { WebsocketConnectionService } from './services/websocket-connection.servce';

export async function app() {
  const cacheService = new CacheService();

  const dbService = new DBService();
  await dbService.init();

  process.on('SIGINT', async () => {
    await stateManagerService.persistToDbNow();
    process.exit();
  });
  process.on('SIGTERM', async () => {
    await stateManagerService.persistToDbNow();
    process.exit();
  });

  const nearService = new NearService();
  await nearService.init();

  const intentsService = new IntentsService(nearService);

  const stateManagerService = new StateManagerService(cacheService, dbService, intentsService);
  await stateManagerService.loadFromDb();

  const quoterService = new QuoterService(stateManagerService, nearService);
  await quoterService.updateCurrentState();

  const cronService = new CronService(quoterService);
  cronService.start();

  const websocketService = new WebsocketConnectionService(quoterService, cacheService);
  websocketService.start();

  const httpService = new HttpService();
  httpService.start();
}
