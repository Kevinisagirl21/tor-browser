/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsCOMPtr.h"

#include "ILoxService.h"

// Inspired by
// toolkit/components/extensions/storage/ExtensionStorageComponents.h.

// Implemented in Rust
extern "C" nsresult NewLoxServiceImpl(ILoxService** aResult);

namespace torproject {
already_AddRefed<ILoxService> NewLoxService() {
  nsCOMPtr<ILoxService> service;
  nsresult rv = NewLoxServiceImpl(getter_AddRefs(service));
  if (NS_WARN_IF(NS_FAILED(rv))) {
    return nullptr;
  }
  return service.forget();
}
}  // namespace torproject
