# Сторонние компоненты

| Компонент | Источник и лицензия |
| --- | --- |
| OpenWrt, LuCI, пакеты и init Xray | [OpenWrt](https://github.com/openwrt/openwrt), лицензии отдельных пакетов; прошивка сохранена без изменений |
| Xray-core | [XTLS/Xray-core](https://github.com/XTLS/Xray-core), MPL-2.0 |
| zapret2 | [bol-van/zapret2](https://github.com/bol-van/zapret2), условия соответствующего сохранённого upstream |
| whitelist-bypass/relay | [kulikov0/whitelist-bypass](https://github.com/kulikov0/whitelist-bypass), MIT; commit `89d7a474b7aca6cce664280e6feeaeca2706733b`, копия лицензии в `components/relay/LICENSE` |
| Go-зависимости joiner | Точные версии и хеши в `go.mod`/`go.sum`; лицензии принадлежат авторам модулей |
| Re:filter | [1andrevich/Re-filter-lists](https://github.com/1andrevich/Re-filter-lists), сохраняется исходный geosite-артефакт и источник обновления |
| Оформление README | Структура вдохновлена [SDL3-CS](https://github.com/edwardgushchin/SDL3-CS); код, логотип и название оттуда не копировались |

Копирование резервной копии в личный Git не меняет лицензии пакетов и владение приватными данными. Перед публичным распространением firmware/бинарников выполните требования соответствующих лицензий, включая предоставление исходников там, где это требуется. Открытая лицензия инструментов не распространяется на личные данные внутри ciphertext.
