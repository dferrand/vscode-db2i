import { getInstance } from "../base";

import * as path from "path";
import { OutputChannel, extensions, window } from "vscode";
import { Config } from "../config";

import { stat } from "fs/promises";
import { SERVER_VERSION_FILE } from "./SCVersion";

import IBMi from "@halcyontech/vscode-ibmi-types/api/IBMi";
import * as Crypto from 'crypto';
import { readFileSync } from "fs";

const ExecutablePathDir = `$HOME/.vscode/`;

export enum UpdateStatus {
  FAILED,
  NONE_AVAILABLE,
  UP_TO_DATE,
  DECLINED_UPDATE,
  JUST_UPDATED,
}

export class ServerComponent {
  private static installed: boolean = false;
  static outputChannel: OutputChannel;

  static initOutputChannel() {
    if (!this.outputChannel) {
      this.outputChannel = window.createOutputChannel(`Db2 for i Server Component`, `json`);
    }

    return this.outputChannel;
  }

  static writeOutput(jsonString: string, show = false) {
    if (show) {
      this.outputChannel.show();
    }

    if (this.outputChannel) {
      this.outputChannel.appendLine(jsonString);
    }
  }

  static isInstalled() {
    return this.installed;
  }

  static getInitCommand(): string | undefined {
    const path = this.getComponentPath();

    if (path) {
      return `/QOpenSys/QIBM/ProdData/JavaVM/jdk80/64bit/bin/java -Dos400.stdio.convert=N -jar ${path} --single`
    }
  }

  static getComponentPath(): string | undefined {
    if (Config.ready) {
      const installedVersion = Config.getServerComponentName();

      if (installedVersion) {
        return path.posix.join(ExecutablePathDir, installedVersion);
      }
    }

    return;
  }

  static async initialise(): Promise<boolean> {
    const instance = getInstance();
    const connection = instance.getConnection();

    if (!connection) {
      return false;
    }

    if (!Config.ready) {
      Config.setConnectionName(connection.currentConnectionName);
    }

    if (!this.installed) {
      this.installed = await this.isAlreadyInstalled();
    }

    return this.installed;
  }

  static reset(){
    this.installed = false;
  }

  static async isAlreadyInstalled() {
    const instance = getInstance();
    const connection = instance.getConnection();

    const exists = await connection.sendCommand({
      command: `ls ${this.getComponentPath()}`
    });

    return (exists.code === 0);
  }

  /**
   * Returns whether server component is installed.
   */
  public static async checkForUpdate(): Promise<UpdateStatus> {
    let updateResult: UpdateStatus = UpdateStatus.NONE_AVAILABLE;

    const extensionPath = extensions.getExtension(`halcyontechltd.vscode-db2i`).extensionPath;
    const instance = getInstance();
    const connection = instance.getConnection();

    try {
      const assetPath = path.join(extensionPath, `dist`, SERVER_VERSION_FILE);
      const assetExistsLocally = await exists(assetPath);

      ServerComponent.writeOutput(JSON.stringify({ assetPath, assetExists: assetExistsLocally }));

      if (assetExistsLocally) {
        const basename = SERVER_VERSION_FILE;
        const lastInstalledName = Config.getServerComponentName();

        ServerComponent.writeOutput(JSON.stringify({ basename, lastInstalledName }));

        await this.initialise();

        if (lastInstalledName !== basename || this.installed === false) {
          // This means we're currently running a different version, 
          // or maybe not at all (currentlyInstalled can be undefined)

          // First, we need their home directory
          const commandResult = await connection.sendCommand({
            command: `echo ${ExecutablePathDir}`
          });

          this.writeOutput(JSON.stringify(commandResult));

          if (commandResult.code === 0) {
            const stuffInStderr = commandResult.stderr.length > 0;
            const remotePath = path.posix.join(commandResult.stdout, basename);

            ServerComponent.writeOutput(JSON.stringify({ remotePath, ExecutablePathDir }));

            const remoteExists = await connection.content.testStreamFile(remotePath, "f");
            const md5IsEqual = remoteExists && await compareMD5Hash(connection, assetPath, remotePath);
            if (!remoteExists || !md5IsEqual) {
              if (remoteExists) {
                const allowWrite = await connection.sendCommand({
                  command: `chmod 600 ${remotePath}`
                });
                if (allowWrite.code !== 0) {
                  this.writeOutput(JSON.stringify(allowWrite));
                  window.showErrorMessage(`Remote file ${remotePath} cannot be written; try to delete it and reconnect.`, 'Show')
                    .then(show => {
                      if (show) {
                        this.outputChannel.show();
                      }
                    });
                  return UpdateStatus.FAILED;
                }
              }
              await connection.uploadFiles([{ local: assetPath, remote: remotePath }]);

              const scAuth = await connection.sendCommand({
                command: `chmod 400 ${remotePath}`
              });

              this.writeOutput(JSON.stringify(scAuth));

              await Config.setServerComponentName(basename);

              if (stuffInStderr) {
                ServerComponent.writeOutput(`Server component was uploaded to ${remotePath} but there was something in stderr, which is not right. It might be worth seeing your user profile startup scripts.`);
              }

              window.showInformationMessage(`Db2 for IBM i extension server component has been updated!`);
              this.installed = true;
              updateResult = UpdateStatus.JUST_UPDATED;
            }
            else{
              await Config.setServerComponentName(basename);
              this.installed = true;
              updateResult = UpdateStatus.UP_TO_DATE;
            }
          } else {
            updateResult = UpdateStatus.FAILED;

            window.showErrorMessage(`Something went really wrong when trying to fetch your home directory.`).then(chosen => {
              if (chosen === `Show`) {
                this.outputChannel.show();
              }
            });
          }

        } else {
          // Already installed. Move along
          updateResult = UpdateStatus.UP_TO_DATE;
        }

      } else {
        // Uh oh. A release was made by there's no jar file??
        ServerComponent.writeOutput('Unable to get file name from server component release.');
        updateResult = UpdateStatus.NONE_AVAILABLE;
      }

    } catch (e) {
      updateResult = UpdateStatus.FAILED;
      ServerComponent.writeOutput(JSON.stringify(e));
      console.log(e);

      window.showErrorMessage(`Something went really wrong during the update process! Check the Db2 for i Output log for the log`, `Show`).then(chosen => {
        if (chosen === `Show`) {
          this.outputChannel.show();
        }
      });
    }

    return updateResult;
  }
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (e) {
    return false;
  }
}

async function compareMD5Hash(connection: IBMi, local: string, remote: string) {
  const localMD5 = Crypto.createHash("md5")
    .update(readFileSync(local))
    .digest("hex")
    .toLowerCase();

  const remoteMD5Result = (await connection.sendCommand({ command: `${connection.remoteFeatures.md5sum} ${remote}` }));
  if (remoteMD5Result.code === 0) {
    return localMD5 === remoteMD5Result.stdout.split(/\s+/)[0];
  }
  else {
    ServerComponent.writeOutput(JSON.stringify(remoteMD5Result));
    return false;
  }
}