// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import { FileSystem, Terminal } from '@rushstack/node-core-library';

import { IHeftPlugin } from '../../pluginFramework/IHeftPlugin';
import { HeftSession } from '../../pluginFramework/HeftSession';
import { HeftConfiguration } from '../../configuration/HeftConfiguration';
import { IBundleStage, IBuildActionContext } from '../../cli/actions/BuildAction';
import { ApiExtractorRunner } from './ApiExtractorRunner';

const PLUGIN_NAME: string = 'ApiExtractorPlugin';
const CONFIG_FILE_LOCATION: string = './config/api-extractor.json';

interface IRunApiExtractorOptions {
  heftConfiguration: HeftConfiguration;
  buildFolder: string;
  debugMode: boolean;
  watchMode: boolean;
  production: boolean;
}

export class ApiExtractorPlugin implements IHeftPlugin {
  public readonly displayName: string = PLUGIN_NAME;

  public apply(heftSession: HeftSession, heftConfiguration: HeftConfiguration): void {
    const { buildFolder } = heftConfiguration;
    if (FileSystem.exists(path.join(buildFolder, CONFIG_FILE_LOCATION))) {
      heftSession.hooks.build.tap(PLUGIN_NAME, (build: IBuildActionContext) => {
        build.hooks.bundle.tap(PLUGIN_NAME, (bundle: IBundleStage) => {
          bundle.hooks.run.tapPromise(PLUGIN_NAME, async () => {
            await this._runApiExtractorAsync({
              heftConfiguration,
              buildFolder,
              debugMode: heftSession.debugMode,
              watchMode: build.properties.watchMode,
              production: build.properties.productionFlag
            });
          });
        });
      });
    }
  }

  private async _runApiExtractorAsync(options: IRunApiExtractorOptions): Promise<void> {
    const { heftConfiguration, buildFolder, debugMode, watchMode, production } = options;

    const terminal: Terminal = ApiExtractorRunner.getTerminal(heftConfiguration.terminalProvider);

    if (watchMode) {
      terminal.writeWarningLine("API Extractor isn't currently supported in --watch mode.");
      return;
    }

    if (!heftConfiguration.compilerPackage) {
      throw new Error('Unable to resolve a compiler package for tsconfig.json');
    }

    const apiExtractorRunner: ApiExtractorRunner = new ApiExtractorRunner(
      heftConfiguration.terminalProvider,
      {
        configFileLocation: CONFIG_FILE_LOCATION,
        apiExtractorPackagePath: heftConfiguration.compilerPackage.apiExtractorPackagePath,
        typescriptPackagePath: heftConfiguration.compilerPackage.typeScriptPackagePath,
        buildFolder: buildFolder,
        production: production
      }
    );
    if (debugMode) {
      await apiExtractorRunner.invokeAsync();
    } else {
      await apiExtractorRunner.invokeAsSubprocessAsync();
    }
  }
}
