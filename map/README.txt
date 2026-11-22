Golden Hour 服务器地图安装说明
================================

本包已经包含一张地图：

    map/
    └─ shipment/
       └─ 3/
          ├─ manifest.json
          ├─ world.json
          ├─ gameplay.json
          └─ scene.glb

服务器启动时会读取 map/catalog.json，然后把地图信息提供给客户端。
客户端下载场景文件的地址是：

    /assets/maps/<地图ID>/<版本>/scene.glb


一、目录结构
------------

所有地图都放在 gh-server/map 下面，每个地图一个目录，每个版本再一个子目录：

    map/
    ├─ catalog.json
    ├─ README.txt
    └─ <地图ID>/
       └─ <版本>/
          ├─ manifest.json
          ├─ world.json
          ├─ gameplay.json
          └─ scene.glb

例如 shipment 的 3 版：

    map/shipment/3/

地图 ID 只能使用小写字母、数字、下划线和短横线，例如：

    shipment
    my_map
    test-map

版本号可以使用字母、数字、点、下划线和短横线，例如：

    1
    3
    v2
    2026.1


二、安装一张新地图
------------------

1. 在 map 下创建地图目录：

       gh-server/map/my_map/1/

2. 把下面四个文件放进去：

       manifest.json
       world.json
       gameplay.json
       scene.glb

3. 打开 map/catalog.json，在 maps 数组里加入：

       {
         "id": "my_map",
         "version": "1"
       }

4. 如果需要让这张地图成为默认地图，把 defaultMap 改成：

       "defaultMap": "my_map"

5. 重启服务器。

6. 检查：

       GET /api/catalog

   应该能看到 my_map。

       GET /assets/maps/my_map/1/scene.glb

   应该返回 200。

客户端进入房间时会自动下载这个场景文件。


三、catalog.json
----------------

示例：

    {
      "schema": 1,
      "defaultMap": "shipment",
      "defaultMode": "tdm",
      "maps": [
        {
          "id": "shipment",
          "version": "3"
        },
        {
          "id": "my_map",
          "version": "1"
        }
      ]
    }

字段说明：

    schema       地图目录格式版本，当前为 1
    defaultMap   默认地图 ID
    defaultMode  默认模式 ID，当前为 tdm
    maps         地图列表，每项必须包含 id 和 version

服务器只会加载 maps 中列出的地图。
如果 catalog.json 不存在，服务器会尝试自动扫描 map 目录。


四、manifest.json
-----------------

示例：

    {
      "schema": 1,
      "id": "shipment",
      "name": "装卸货场",
      "version": "3",
      "clientScene": "gltf",
      "sceneAsset": "assets/maps/shipment/3/scene.glb",
      "sceneBytes": 16349380,
      "sceneSHA256": "13b15cc09396b6d0eb5c59caef8a2d3cac018e8675e644172c5cafc24814c55b",
      "worldAsset": "world.json",
      "gameplayAsset": "gameplay.json",
      "environment": {
        "background": "b8b3a7",
        "fogColor": "b8b3a7",
        "fogDensity": 0.0048
      }
    }

重要字段：

    id            必须和目录名一致
    version       必须和版本目录名一致
    name          客户端显示名称
    clientScene   场景类型，当前使用 gltf
    sceneAsset    场景文件路径，必须是：
                  assets/maps/<地图ID>/<版本>/scene.glb
    sceneBytes    文件大小，可选
    sceneSHA256   文件 SHA-256，可选
    worldAsset    固定为 world.json
    gameplayAsset 固定为 gameplay.json
    environment   背景色、雾色、雾密度，可选

sceneAsset 不要写成绝对路径，也不要用 ../。
它必须能从服务器的 /assets/maps/ 路径访问。


五、world.json
--------------

world.json 是服务端物理数据，主要包含：

    bounds       地图边界
    colliders    碰撞盒
    nodes        导航节点，供 HackBot 寻路使用

安装一张新地图时，如果没有碰撞数据，玩家会掉出地图。
如果没有导航节点，HackBot 仍然可以生成，但无法正常寻路。


六、gameplay.json
-----------------

gameplay.json 主要包含：

    spawns       出生点，每项包含 pos、yaw、team

team 为 0 或 1。
每边至少需要一个出生点，否则玩家可能无法正常生成。


七、地图来源
------------

如果地图来自官方客户端资源，通常可以从对应 build 的：

    /assets/maps/<地图ID>/<版本>/

取得：

    scene.glb
    world.json
    gameplay.json
    manifest.json

复制到本地 map/<地图ID>/<版本>/ 后，修改 manifest.json 的 id、version、
sceneAsset 和 name，再更新 catalog.json。

注意：不同客户端 build 的地图版本可能不同。
例如官方客户端请求 shipment/3 时，服务器就必须提供 shipment/3，
不能只放 shipment/2。


八、常见问题
------------

1. 客户端一直下载地图失败

   检查：
   - /assets/maps/<ID>/<版本>/scene.glb 是否返回 200
   - manifest.json 里的 sceneAsset 是否和实际路径一致
   - catalog.json 里是否有这张地图
   - 服务器是否有 map 目录

2. /api/catalog 看不到新地图

   检查：
   - catalog.json 是否是合法 JSON
   - maps 数组里是否加入了 id 和 version
   - 目录是否是 map/<id>/<version>/
   - manifest.json 是否存在

3. 玩家出生后掉出地图

   检查 world.json 的 bounds 和 colliders。
   检查 gameplay.json 的 spawns 是否在地图内部。

4. 客户端提示地图版本不匹配

   检查客户端当前请求的版本，例如：

       shipment/3

   服务器必须存在完全相同的：

       map/shipment/3/

5. 想删除地图

   从 catalog.json 的 maps 数组删除对应项，然后删除地图目录，重启服务器。


九、本包自带地图
----------------

    shipment / 3

文件：

    scene.glb       16349380 字节
    world.json      195310 字节
    gameplay.json   2314 字节
    manifest.json   439 字节

SHA-256：

    13b15cc09396b6d0eb5c59caef8a2d3cac018e8675e644172c5cafc24814c55b

删除或替换地图后，记得同步更新 catalog.json。
