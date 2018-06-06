// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

export interface Error {
  code: any
  id: any
  message: any
  innerErrors: Error[]
  path?: any
  inner?: Error[]
}