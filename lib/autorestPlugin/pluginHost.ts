/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// import vscodeJsonRpc = require("vscode-jsonrpc")
import * as linq from "linq"
import * as jsonPath from "jsonpath"
import * as yaml from "js-yaml"
import * as utils from "../util/utils"
import { log } from "../util/logging"
import { SpecValidator } from "../validators/specValidator"
import * as extensionBase from "@microsoft.azure/autorest-extension-base"
import { IAutoRestPluginInitiator } from
  "@microsoft.azure/autorest-extension-base/dist/lib/extension-base"

const openAPIDocUrl = "https://github.com/Azure/oav"

const extension = new extensionBase.AutoRestExtension()
const modelValidatorPluginName = "model-validator"
const modelValidationCategory = "ExampleModelViolation"

class FormattedOutput {
  constructor(
    public readonly channel: string,
    public readonly details: any,
    public readonly code: any[],
    public readonly text: string,
    public readonly source: any[]) {
  }
}

/**
 * Returns a promise with the examples validation of the swagger.
 */
async function analyzeSwagger(swaggerFileName: string, autoRestApi: extensionBase.Host)
  : Promise<void> {
  const swaggerFile = await autoRestApi.ReadFile(swaggerFileName)
  const swagger = yaml.safeLoad(swaggerFile)
  const exampleValidationResults = await openApiValidationExample(swagger, swaggerFileName)
  for (const result of exampleValidationResults) {
    autoRestApi.Message({
      Channel: result.channel,
      Text: result.text,
      Details: result.details,
      Key: result.code,
      Source: result.source,
    })
  }
  // console.error(JSON.stringify(exampleValidationResults, null, 2))
}

extension.Add(
  modelValidatorPluginName,
  async (autoRestApi: IAutoRestPluginInitiator): Promise<void> => {
    const swaggerFileNames = await autoRestApi.ListInputs()
    const promises = swaggerFileNames.map(
      swaggerFileName => analyzeSwagger(swaggerFileName, autoRestApi))
    await Promise.all(promises)
  })

export async function openApiValidationExample(
  swagger: yaml.DocumentLoadResult, swaggerFileName: string, options?: any)
  : Promise<any[]> {
  const formattedResult: FormattedOutput[] = []
  if (!options) { options = {} }
  options.consoleLogLevel = "off"
  log.consoleLogLevel = options.consoleLogLevel
  const specVal = new SpecValidator(swaggerFileName, swagger, options)
  // console.error(JSON.stringify(swagger, null, 2))
  await specVal.initialize()
  try {
    specVal.validateOperations()
    const specValidationResult = specVal.specValidationResult
    for (const op of utils.getKeys(specValidationResult.operations)) {
      const xmsExamplesNode = specValidationResult.operations[op]["x-ms-examples"];
      for (const scenario of utils.getKeys(xmsExamplesNode.scenarios)) {
        // invalid? meaning that there's an issue found in the validation
        const scenarioItem = xmsExamplesNode.scenarios[scenario]
        if (scenarioItem.isValid === false) {
          // get path to x-ms-examples in swagger
          const xmsexPath = linq
            .from(jsonPath.nodes(
              swagger, `$.paths[*][?(@.operationId==='${op}')]["x-ms-examples"]`))
            .select((x: any) => x.path)
            .firstOrDefault();
          if (!xmsexPath) {
            throw new Error("Model Validator: Path to x-ms-examples not found.")
          }
          // console.error(JSON.stringify(scenarioItem, null, 2));
          let result = new FormattedOutput(
            "verbose",
            { scenarioItem, scenario },
            [modelValidationCategory],
            "Model validator found issue (see details).",
            [{ document: swaggerFileName, Position: { path: xmsexPath } }])
          formattedResult.push(result)

          // request
          const request = scenarioItem.request
          if (request.isValid === false) {
            const error = request.error
            const innerErrors = error.innerErrors
            if (!innerErrors || !innerErrors.length) {
              throw new Error("Model Validator: Unexpected format.")
            }
            for (const innerError of innerErrors) {
              const path = convertIndicesFromStringToNumbers(innerError.path)
              // console.error(JSON.stringify(error, null, 2))
              const resultDetails = {
                type: "Error",
                code: error.code,
                message: error.message,
                id: error.id,
                validationCategory: modelValidationCategory,
                innerErrors: innerError,
              }
              result = new FormattedOutput(
                "error",
                resultDetails,
                [error.code, error.id, modelValidationCategory],
                innerError.message
                  + ". \nScenario: "
                  + scenario
                  + ". \nDetails: "
                  + JSON.stringify(innerError.errors, null, 2)
                  + "\nMore info: "
                  + openAPIDocUrl
                  + "#"
                  + error.id.toLowerCase()
                  + "-"
                  + error.code.toLowerCase()
                  + "\n",
                [{ document: swaggerFileName, Position: { path } }])
              formattedResult.push(result)
            }
          }

          // responses
          for (const responseCode of utils.getKeys(scenarioItem.responses)) {
            const response = scenarioItem.responses[responseCode]
            if (response.isValid === false) {
              const error = response.error
              const innerErrors = error.innerErrors
              if (!innerErrors || !innerErrors.length) {
                throw new Error("Model Validator: Unexpected format.")
              }
              for (const innerError of innerErrors) {
                // console.error(JSON.stringify(error, null, 2));
                const resultDetails = {
                  type: "Error",
                  code: error.code,
                  message: error.message,
                  id: error.id,
                  validationCategory: modelValidationCategory,
                  innerErrors: innerError,
                }
                result = new FormattedOutput(
                  "error",
                  resultDetails,
                  [error.code, error.id, modelValidationCategory],
                  innerError.message
                    + ". \nScenario: "
                    + scenario
                    + ". \nDetails: "
                    + JSON.stringify(innerError.errors, null, 2)
                    + "\nMore info: "
                    + openAPIDocUrl
                    + "#"
                    + error.id.toLowerCase()
                    + "-"
                    + error.code.toLowerCase() + "\n",
                  [{
                    document: swaggerFileName,
                    Position: {
                      path: xmsexPath
                        .slice(0, xmsexPath.length - 1)
                        .concat(["responses", responseCode]),
                    },
                  }])
                formattedResult.push(result)
              }
            }
          }
        }
      }
    }
    return formattedResult
  } catch (err) {
    /* tslint:disable-next-line:no-console */
    console.error(err)
    throw err
  }
}
/**
 * Path comes with indices as strings in "inner errors", so converting those to actual numbers for
 * path to work.
 */
function convertIndicesFromStringToNumbers(path: any) {
  const result = path.slice()
  for (let i = 1; i < result.length; ++i) {
    const num = parseInt(result[i])
    if (!isNaN(num) && result[i - 1] === "parameters") {
      result[i] = num
    }
  }
  return result
}

extension.Run()