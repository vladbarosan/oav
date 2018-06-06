﻿// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

import * as util from "util"
import * as path from "path"
import * as os from "os"
import * as url from "url"
import * as _ from "lodash"
import * as glob from "glob"
import * as msRest from "ms-rest"
import { SpecValidator } from "./specValidator"
import { Constants } from "../util/constants"
import { log } from "../util/logging"
import * as utils from "../util/utils"
import * as models from "../models"
import * as http from "http"
import { PotentialOperationsResult } from "../models/potentialOperationsResult"

export interface Options {
  swaggerPaths: string[]
  git: {
    url: string
    shouldClone: boolean
    branch?: string
  }
  directory: string
  swaggerPathsPattern?: string
  shouldModelImplicitDefaultResponse?: boolean
  isPathCaseSensitive?: boolean
}

export interface Operation {
  pathObject: {
    path: string
    regexp: RegExp
  }
  responses: {
    default: {
      schema: {
        properties: {
          [property: string]: {}
        }
      }
    }
  }
}

export interface ApiVersion {
  [method: string]: Operation[]
}

export interface Provider {
  [apiVersion: string]: ApiVersion
}

/**
 * @class
 * Live Validator for Azure swagger APIs.
 */
export class LiveValidator {
  public cache: {
    [provider: string]: Provider
  }
  public options: Options
  /**
   * Constructs LiveValidator based on provided options.
   *
   * @param {object} options The configuration options.
   *
   * @param {array} [options.swaggerPaths] Array of swagger paths to be used for initializing Live
   *    Validator. This has precedence over {@link options.swaggerPathsPattern}.
   *
   * @param {string} [options.swaggerPathsPattern] Pattern for swagger paths to be used for
   *    initializing Live Validator.
   *
   * @param {string} [options.isPathCaseSensitive] Specifies if the swagger path is to be considered
   *    case sensitive.
   *
   * @param {string} [options.git.url] The url of the github repository. Defaults to
   *    "https://github.com/Azure/azure-rest-api-specs.git".
   *
   * @param {string} [options.git.shouldClone] Specifies whether to clone the repository or not.
   *    Defaults to false.
   *
   * @param {string} [options.git.branch] The branch  of the github repository to use instead of the
   *    default branch.
   *
   * @param {string} [options.directory] The directory where to clone github repository or from
   *    where to find swaggers. Defaults to "repo" under user directory.
   *
   * @param {string} [options.shouldModelImplicitDefaultResponse] Specifies if to model a default
   *    response for operations even if it is not specified in the specs.
   *
   * @returns {object} CacheBuilder Returns the configured CacheBuilder object.
   */
  constructor(options?: any) {

    this.options = options === null || options === undefined
      ? { }
      : options

    if (typeof this.options !== "object") {
      throw new Error('options must be of type "object".')
    }
    if (this.options.swaggerPaths === null || this.options.swaggerPaths === undefined) {
      this.options.swaggerPaths = []
    }
    if (!Array.isArray(this.options.swaggerPaths)) {
      const paths = typeof this.options.swaggerPaths
      throw new Error(
        `options.swaggerPaths must be of type "array" instead of type "${paths}".`)
    }
    if (this.options.git === null || this.options.git === undefined) {
      this.options.git = {
        url: "https://github.com/Azure/azure-rest-api-specs.git",
        shouldClone: false
      }
    }
    if (typeof this.options.git !== "object") {
      throw new Error('options.git must be of type "object".')
    }
    if (this.options.git.url === null || this.options.git.url === undefined) {
      this.options.git.url = "https://github.com/Azure/azure-rest-api-specs.git"
    }
    if (typeof this.options.git.url.valueOf() !== "string") {
      throw new Error('options.git.url must be of type "string".')
    }
    if (this.options.git.shouldClone === null || this.options.git.shouldClone === undefined) {
      this.options.git.shouldClone = false
    }
    if (typeof this.options.git.shouldClone !== "boolean") {
      throw new Error('options.git.shouldClone must be of type "boolean".')
    }
    if (this.options.directory === null || this.options.directory === undefined) {
      this.options.directory = path.resolve(os.homedir(), "repo")
    }
    if (typeof this.options.directory.valueOf() !== "string") {
      throw new Error('options.directory must be of type "string".')
    }
    this.cache = {}
  }

  /**
   * Initializes the Live Validator.
   */
  public async initialize(): Promise<void> {

    // Clone github repository if required
    if (this.options.git.shouldClone) {
      utils.gitClone(this.options.directory, this.options.git.url, this.options.git.branch)
    }

    // Construct array of swagger paths to be used for building a cache
    let swaggerPaths: string[]
    if (this.options.swaggerPaths.length !== 0) {
      swaggerPaths = this.options.swaggerPaths
      log.debug(`Using user provided swagger paths. Total paths: ${swaggerPaths.length}`)
    } else {
      const allJsonsPattern = "/specification/**/*.json"
      const jsonsPattern = path.join(
        this.options.directory, this.options.swaggerPathsPattern || allJsonsPattern)
      swaggerPaths = glob.sync(
        jsonsPattern,
        {
          ignore: [
            "**/examples/**/*",
            "**/quickstart-templates/**/*",
            "**/schema/**/*",
            "**/live/**/*",
            "**/wire-format/**/*"
          ]
        })
      const dir = this.options.directory
      log.debug(
        `Using swaggers found from directory "${dir}" and pattern "${jsonsPattern}".` +
        `Total paths: ${swaggerPaths.length}`)
    }
    // console.log(swaggerPaths);
    // Create array of promise factories that builds up cache
    // Structure of the cache is
    // {
    //   "provider1": {
    //     "api-version1": {
    //       "get": [
    //         "operation1",
    //         "operation2",
    //       ],
    //       "put": [
    //         "operation1",
    //         "operation2",
    //       ],
    //       ...
    //     },
    //     ...
    //   },
    //   "microsoft.unknown": {
    //     "unknown-api-version": {
    //      "post": [
    //        "operation1"
    //      ]
    //    }
    //   }
    //   ...
    // }
    const promiseFactories = swaggerPaths.map(swaggerPath => {
      return async () => {
        log.info(`Building cache from: "${swaggerPath}"`)

        const validator = new SpecValidator(
          swaggerPath,
          null,
          {
            shouldModelImplicitDefaultResponse: this.options.shouldModelImplicitDefaultResponse,
            isPathCaseSensitive: this.options.isPathCaseSensitive
          })

        try {
          const api = await validator.initialize()

          const operations = api.getOperations()
          let apiVersion = api.info.version.toLowerCase()

          operations.forEach((operation: any) => {
            const httpMethod = operation.method.toLowerCase()
            const pathStr = operation.pathObject.path
            let provider = utils.getProvider(pathStr)
            log.debug(`${apiVersion}, ${operation.operationId}, ${pathStr}, ${httpMethod}`)

            if (!provider) {
              const title = api.info.title

              // Whitelist lookups: Look up knownTitleToResourceProviders
              // Putting the provider namespace onto operation for future use
              if (title && (Constants.knownTitleToResourceProviders as any)[title]) {
                operation.provider = (Constants.knownTitleToResourceProviders as any)[title]
              }

              // Put the operation into 'Microsoft.Unknown' RPs
              provider = Constants.unknownResourceProvider
              apiVersion = Constants.unknownApiVersion
              log.debug(
                `Unable to find provider for path : "${operation.pathObject.path}". ` +
                `Bucketizing into provider: "${provider}"`)
            }
            provider = provider.toLowerCase()

            // Get all api-version for given provider or initialize it
            const apiVersions = this.cache[provider] || {}
            // Get methods for given apiVersion or initialize it
            const allMethods = apiVersions[apiVersion] || {}
            // Get specific http methods array for given verb or initialize it
            const operationsForHttpMethod = allMethods[httpMethod] || []

            // Builds the cache
            operationsForHttpMethod.push(operation)
            allMethods[httpMethod] = operationsForHttpMethod
            apiVersions[apiVersion] = allMethods
            this.cache[provider] = apiVersions
          })

        } catch (err) {
          // Do Not reject promise in case, we cannot initialize one of the swagger
          log.debug(`Unable to initialize "${swaggerPath}" file from SpecValidator. Error: ${err}`)
          log.warn(
            `Unable to initialize "${swaggerPath}" file from SpecValidator. We are ` +
            `ignoring this swagger file and continuing to build cache for other valid specs.`)
        }
      }
    })

    await utils.executePromisesSequentially(promiseFactories)
    log.info("Cache initialization complete.")
  }

  /**
   * Gets list of potential operations objects for given path and method.
   *
   * @param {string} requestPath The path of the url for which to find potential operations.
   *
   * @param {string} requestMethod The http verb for the method to be used for lookup.
   *
   * @param {Array<Operation>} operations The list of operations to search.
   *
   * @returns {Array<Operation>} List of potential operations matching the requestPath.
   */
  public getPotentialOperationsHelper(
    requestPath: string, requestMethod: string, operations: Operation[]): any[] {
    if (requestPath === null
      || requestPath === undefined
      || typeof requestPath.valueOf() !== "string"
      || !requestPath.trim().length) {
      throw new Error(
        'requestPath is a required parameter of type "string" and it cannot be an empty string.')
    }

    if (requestMethod === null
      || requestMethod === undefined
      || typeof requestMethod.valueOf() !== "string"
      || !requestMethod.trim().length) {
      throw new Error(
        'requestMethod is a required parameter of type "string" and it cannot be an empty string.')
    }

    if (operations === null || operations === undefined || !Array.isArray(operations)) {
      throw new Error('operations is a required parameter of type "array".')
    }

    const self = this
    let potentialOperations = []
    potentialOperations = operations.filter((operation) => {
      const pathMatch = operation.pathObject.regexp.exec(requestPath)
      return pathMatch === null ? false : true
    })

    // If we do not find any match then we'll look into Microsoft.Unknown -> unknown-api-version
    // for given requestMethod as the fall back option
    if (!potentialOperations.length) {
      if (self.cache[Constants.unknownResourceProvider] &&
        self.cache[Constants.unknownResourceProvider][Constants.unknownApiVersion]) {
        operations = self.cache
          [Constants.unknownResourceProvider][Constants.unknownApiVersion][requestMethod]
        potentialOperations = operations.filter((operation) => {
          let pathTemplate = operation.pathObject.path
          if (pathTemplate && pathTemplate.includes("?")) {
            pathTemplate = pathTemplate.slice(0, pathTemplate.indexOf("?"))
            operation.pathObject.path = pathTemplate
          }
          const pathMatch = operation.pathObject.regexp.exec(requestPath)
          return pathMatch === null ? false : true
        })
      }
    }

    return potentialOperations
  }

  /**
   * Gets list of potential operations objects for given url and method.
   *
   * @param {string} requestUrl The url for which to find potential operations.
   *
   * @param {string} requestMethod The http verb for the method to be used for lookup.
   *
   * @returns {PotentialOperationsResult} Potential operation result object.
   */
  public getPotentialOperations(requestUrl: string, requestMethod: string)
    : PotentialOperationsResult {

    if (_.isEmpty(this.cache)) {
      const msgStr =
        `Please call "liveValidator.initialize()" before calling this method, ` +
        `so that cache is populated.`
      throw new Error(msgStr)
    }

    if (requestUrl === null
      || requestUrl === undefined
      || typeof requestUrl.valueOf() !== "string"
      || !requestUrl.trim().length) {
      throw new Error(
        'requestUrl is a required parameter of type "string" and it cannot be an empty string.')
    }

    if (requestMethod === null
      || requestMethod === undefined
      || typeof requestMethod.valueOf() !== "string"
      || !requestMethod.trim().length) {
      throw new Error(
        'requestMethod is a required parameter of type "string" and it cannot be an empty string.')
    }

    const self = this
    let potentialOperations: any[] = []
    const parsedUrl = url.parse(requestUrl, true)
    const pathStr = parsedUrl.pathname
    requestMethod = requestMethod.toLowerCase()
    let result
    let msg
    let code
    let liveValidationError
    if (pathStr === null || pathStr === undefined) {
      msg = `Could not find path from requestUrl: "${requestUrl}".`
      liveValidationError = new models.LiveValidationError(
        Constants.ErrorCodes.PathNotFoundInRequestUrl.name, msg)
      result = new models.PotentialOperationsResult(potentialOperations, liveValidationError)
      return result
    }

    // Lower all the keys of query parameters before searching for `api-version`
    const queryObject = _.transform(
      parsedUrl.query, (obj, value, key) => obj[key.toLowerCase()] = value)
    let apiVersion: any = queryObject["api-version"]
    let provider = utils.getProvider(pathStr)

    // Provider would be provider found from the path or Microsoft.Unknown
    provider = provider || Constants.unknownResourceProvider
    if (provider === Constants.unknownResourceProvider) {
      apiVersion = Constants.unknownApiVersion
    }
    provider = provider.toLowerCase()

    // Search using provider
    const allApiVersions = self.cache[provider]
    if (allApiVersions) {
      // Search using api-version found in the requestUrl
      if (apiVersion) {
        const allMethods = allApiVersions[apiVersion]
        if (allMethods) {
          const operationsForHttpMethod = allMethods[requestMethod]
          // Search using requestMethod provided by user
          if (operationsForHttpMethod) {
            // Find the best match using regex on path
            potentialOperations = self.getPotentialOperationsHelper(
              pathStr, requestMethod, operationsForHttpMethod)
            // If potentialOperations were to be [] then we need reason
            msg =
              `Could not find best match operation for verb "${requestMethod}" for api-version ` +
              `"${apiVersion}" and provider "${provider}" in the cache.`
            code = Constants.ErrorCodes.OperationNotFoundInCache
          } else {
            msg =
              `Could not find any methods with verb "${requestMethod}" for api-version ` +
              `"${apiVersion}" and provider "${provider}" in the cache.`
            code = Constants.ErrorCodes.OperationNotFoundInCacheWithVerb
            log.debug(msg)
          }
        } else {
          msg =
            `Could not find exact api-version "${apiVersion}" for provider "${provider}" ` +
            `in the cache.`
          code = Constants.ErrorCodes.OperationNotFoundInCacheWithApi
          log.debug(`${msg} We'll search in the resource provider "Microsoft.Unknown".`)
          potentialOperations = self.getPotentialOperationsHelper(pathStr, requestMethod, [])
        }
      } else {
        msg = `Could not find api-version in requestUrl "${requestUrl}".`
        code = Constants.ErrorCodes.OperationNotFoundInCacheWithApi
        log.debug(msg)
      }
    } else {
      // provider does not exist in cache
      msg = `Could not find provider "${provider}" in the cache.`
      code = Constants.ErrorCodes.OperationNotFoundInCacheWithProvider
      log.debug(`${msg} We'll search in the resource provider "Microsoft.Unknown".`)
      potentialOperations = self.getPotentialOperationsHelper(pathStr, requestMethod, [])
    }

    // Provide reason when we do not find any potential operaion in cache
    if (potentialOperations.length === 0) {
      liveValidationError = new models.LiveValidationError(code.name, msg)
    }

    result = new models.PotentialOperationsResult(potentialOperations, liveValidationError)
    return result
  }

  /**
   * Validates live request and response.
   *
   * @param {object} requestResponseObj - The wrapper that constains the live request and response
   * @param {object} requestResponseObj.liveRequest - The live request
   * @param {object} requestResponseObj.liveResponse - The live response
   * @returns {object} validationResult - Validation result for given input
   */
  public validateLiveRequestResponse(requestResponseObj: any) {
    const self = this
    const validationResult = {
      requestValidationResult: {
        successfulRequest: false,
        operationInfo: undefined as any,
        errors: undefined as any
      },
      responseValidationResult: {
        successfulResponse: false,
        operationInfo: undefined as any,
        errors: undefined as any
      },
      errors: [] as any[]
    };
    if (!requestResponseObj || (requestResponseObj && typeof requestResponseObj !== "object")) {
      const msg = 'requestResponseObj cannot be null or undefined and must be of type "object".'
      const e = new models.LiveValidationError(Constants.ErrorCodes.IncorrectInput.name, msg)
      validationResult.errors.push(e)
      return validationResult
    }
    try {
      // We are using this to validate the payload as per the definitions in swagger.
      // We do not need the serialized output from ms-rest.
      const mapper = new models.RequestResponse().mapper();
      (msRest as any).models = models;
      (msRest as any).serialize(mapper, requestResponseObj, "requestResponseObj");
    } catch (err) {
      const msg =
        `Found errors "${err.message}" in the provided input:\n` +
        `${util.inspect(requestResponseObj, { depth: null })}.`
      const e = new models.LiveValidationError(Constants.ErrorCodes.IncorrectInput.name, msg)
      validationResult.errors.push(e)
      return validationResult
    }
    const request = requestResponseObj.liveRequest
    const response = requestResponseObj.liveResponse

    // If status code is passed as a status code string (e.g. "OK") tranform it to the status code
    // number (e.g. '200').
    if (response
      && !http.STATUS_CODES[response.statusCode]
      && utils.statusCodeStringToStatusCode[response.statusCode.toLowerCase()]) {
      response.statusCode = utils.statusCodeStringToStatusCode[response.statusCode.toLowerCase()]
    }

    if (!request.query) {
      request.query = url.parse(request.url, true).query
    }
    const currentApiVersion = request.query["api-version"] || Constants.unknownApiVersion
    let potentialOperationsResult
    let potentialOperations = []
    try {
      potentialOperationsResult = self.getPotentialOperations(request.url, request.method)
      potentialOperations = potentialOperationsResult.operations
    } catch (err) {
      const msg =
        `An error occured while trying to search for potential operations:\n` +
        `${util.inspect(err, { depth: null })}`
      const e = new models.LiveValidationError(
        Constants.ErrorCodes.PotentialOperationSearchError.name, msg)
      validationResult.errors.push(e)
      return validationResult
    }

    // Found empty potentialOperations
    if (potentialOperations.length === 0) {
      validationResult.errors.push(potentialOperationsResult.reason)
      return validationResult
    // Found exactly 1 potentialOperations
    } else if (potentialOperations.length === 1) {
      const operation = potentialOperations[0]
      const basicOperationInfo = {
        operationId: operation.operationId,
        apiVersion: currentApiVersion
      }
      validationResult.requestValidationResult.operationInfo = [basicOperationInfo]
      validationResult.responseValidationResult.operationInfo = [basicOperationInfo]
      let reqResult
      try {
        reqResult = operation.validateRequest(request)
        validationResult.requestValidationResult.errors = reqResult.errors || []
        log.debug("Request Validation Result")
        log.debug(reqResult)
      } catch (reqValidationError) {
        const msg =
          `An error occurred while validating the live request for operation ` +
          `"${operation.operationId}". The error is:\n ` +
          `${util.inspect(reqValidationError, { depth: null })}`
        const err = new models.LiveValidationError(
          Constants.ErrorCodes.RequestValidationError.name, msg)
        validationResult.requestValidationResult.errors = [err]
      }
      let resResult
      try {
        resResult = operation.validateResponse(response)
        validationResult.responseValidationResult.errors = resResult.errors || []
        log.debug("Response Validation Result")
        log.debug(resResult)
      } catch (resValidationError) {
        const msg =
          `An error occurred while validating the live response for operation ` +
          `"${operation.operationId}". The error is:\n ` +
          `${util.inspect(resValidationError, { depth: null })}`
        const err = new models.LiveValidationError(
          Constants.ErrorCodes.ResponseValidationError.name, msg)
        validationResult.responseValidationResult.errors = [err]
      }
      if (reqResult
        && reqResult.errors
        && Array.isArray(reqResult.errors)
        && !reqResult.errors.length) {
        validationResult.requestValidationResult.successfulRequest = true
      }
      if (resResult
        && resResult.errors
        && Array.isArray(resResult.errors)
        && !resResult.errors.length) {
        validationResult.responseValidationResult.successfulResponse = true
      }
    // Found more than 1 potentialOperations
    } else {
      const operationIds = potentialOperations.map((op: any) => op.operationId).join()
      const msg =
        `Found multiple matching operations with operationIds "${operationIds}" ` +
        `for request url "${request.url}" with HTTP Method "${request.method}".`;
      log.debug(msg)
      const err = new models.LiveValidationError(
        Constants.ErrorCodes.MultipleOperationsFound.name, msg)
      validationResult.errors = [err]
    }

    return validationResult
  }
}