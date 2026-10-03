import { BootstrapOptions } from "./common";
import * as ControllerApi from "@mercuryworkshop/scramjet-controller";
export declare function init(cfg: BootstrapOptions): Promise<ControllerApi.Controller>;
export declare function loadRest(sw: ServiceWorker, cfg: BootstrapOptions): Promise<ControllerApi.Controller>;
