import http from "http";
import { BootstrapOptions } from "./common";
type ServerBootstrapOptions = BootstrapOptions & {
    downloadedFilesDir: string;
};
declare function routeRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean;
declare function routeUpgrade(req: http.IncomingMessage, socket: any, head: Buffer): boolean;
export declare function unpack(tarball: string, name: string): Promise<void>;
export declare function findLatestVersionOfPackage(packageName: string, majorVersion: string): Promise<NodePackageMeta>;
type NodePackageMeta = {
    name: string;
    version: string;
    dist: {
        tarball: string;
    };
    dependencies: {
        [key: string]: string;
    };
};
export declare function bootstrap(cfg?: Partial<ServerBootstrapOptions>): Promise<{
    routeRequest: typeof routeRequest;
    routeUpgrade: typeof routeUpgrade;
}>;
export {};
