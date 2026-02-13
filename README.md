# Study Together

Firebase Realtime Database でルーム同期し、休憩時だけ音声通話する集中アプリです。  
Firebase Hosting でそのまま公開できる構成にしています。

## 1. 事前準備

1. Firebase Console でプロジェクトを作成
2. Realtime Database を作成 (ロケーションは任意)
3. Authentication で Google プロバイダを有効化
4. Firebase CLI をインストール

```bash
npm install -g firebase-tools
firebase login
```

## 2. プロジェクトIDを設定

`.firebaserc` の `your-firebase-project-id` を実際のプロジェクトIDに置き換えてください。

## 3. Databaseルールを反映

```bash
firebase deploy --only database
```

## 4. Authentication設定

Firebase Console の Authentication > Sign-in method で Google を有効化してください。
必要であれば承認済みドメインに Hosting のドメインを追加します。

## 5. Hostingにデプロイ

```bash
firebase deploy --only hosting
```

デプロイ後は `index.html` が Firebase Hosting から配信され、`/__/firebase/init.js` 経由で Firebase 設定が自動注入されます。  
そのため、アプリ上で API キー等を手入力する必要はありません。

## 補足

- APIキーは Firebase Web アプリの公開設定値であり、クライアントに露出する前提です。
- 実運用では Realtime Database ルールの強化 (認証導入など) を推奨します。
