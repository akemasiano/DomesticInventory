# Maison — inventaire domestique

Maquette mobile de DomesticInventory : inventaire en cartes, navigation par pièce, fiche d’appareil et accès rapide au mode d’emploi. Le repère de garantie est calculé depuis la date de fin saisie ; la fiche reprend cette date complète.

## Aperçu

Ouvrir `index.html` dans un navigateur. La maquette comprend une recherche, des filtres par pièce, une fiche appareil et un formulaire d’ajout. Les appareils d’exemple couvrent les états « sous garantie », « garantie expirée » et « date non renseignée ». Les ajouts restent en mémoire pendant la session.

L’application utilise le projet Supabase de `limpiezaCasa`, mais uniquement ses nouvelles tables `inventory_*`. Les lignes d’exemple ont été retirées : les appareils viennent de l’inventaire partagé après connexion.

## Règles produit retenues

- Seuls les comptes préautorisés par l’administrateur peuvent ouvrir l’inventaire. Les inscriptions publiques sont désactivées.
- Une session doit être authentifiée avant toute lecture ou écriture. Les droits sont vérifiés côté base et stockage, pas seulement en masquant l’interface.
- Les changements sont synchronisés automatiquement après modification, périodiquement pendant que l’application est visible, puis au retour en ligne ou dans l’application. Un statut clair distingue les données synchronisées, en attente et en erreur.
- Une copie locale et une file de changements en attente permettent de continuer hors ligne après une première synchronisation. Les changements en conflit ne sont pas écrasés silencieusement.
- Les manuels sont des PDF dans un espace de stockage privé ; l’application délivre un accès vérifié au membre autorisé. Une sauvegarde des métadonnées doit aussi permettre d’exporter ou de retrouver les fichiers.

## Schéma Supabase préparé

Le script [supabase/domestic-inventory.sql](supabase/domestic-inventory.sql) crée des tables distinctes de Casa : inventaires, membres autorisés, appareils (dont `warranty_end_date`) et documents. Il active les règles RLS, ajoute les fonctions de lecture et d’écriture contrôlées par révision et configure un bucket privé pour les PDF (20 Mo maximum). Il crée l’inventaire vide avec l’ID attendu par l’application. Les modifications à la base passent par une transaction ; une révision périmée est refusée.

La PWA met en cache les fichiers publics de l’application uniquement. Les réponses de Supabase et les PDF privés ne sont jamais placés dans le cache du service worker. Les données de travail hors ligne sont conservées dans le stockage local, par compte.

Pour initialiser l’accès, exécuter le script dans le projet Supabase de Casa, puis ajouter à `public.inventory_members` les identifiants Auth des personnes autorisées. Pour voir les identifiants disponibles dans le SQL Editor :

```sql
select id, email from auth.users order by email;
```

Ajouter seulement les comptes qui doivent utiliser l’inventaire :

```sql
insert into public.inventory_members (inventory_id, user_id, role)
values ('a5a7cb0e-2496-4aed-9f2e-70c80a823511', 'UUID_AUTH_AUTORISE', 'admin')
on conflict (inventory_id, user_id) do nothing;
```

Les inscriptions publiques doivent rester désactivées ; la création des comptes et l’ajout des membres restent des opérations administrateur. La clé publishable dans `supabase-config.js` est prévue pour le navigateur. Ne jamais y placer une clé secrète/service-role.

Les identités Auth sont communes aux deux applications. DomesticInventory lit le prénom existant via la fonction `inventory_profile`; il ne duplique pas de table de profils. `user_profiles` n’est cependant pas la liste de droits : Casa y crée un profil pour les comptes Auth, alors que `inventory_members` n’accorde l’inventaire qu’aux personnes choisies. Comme le schéma initial a déjà été exécuté, lancer une fois [supabase/use-user-profiles.sql](supabase/use-user-profiles.sql) pour ajouter cette lecture du prénom.

Le client inclut l’écran de connexion, vérifie l’appartenance avant d’ouvrir l’inventaire, met les changements en cache local et synchronise à chaque modification, toutes les 15 secondes quand l’application est visible, et au retour en ligne. Les changements concurrents sur des appareils différents sont fusionnés ; pour le même élément, l’application demande quelle version garder. Les PDF sont envoyés au bucket privé et ouverts via un lien signé temporaire.

## Étape suivante

Il reste à exécuter la migration et ajouter les comptes dans Supabase. Le script n’a pas été exécuté depuis le poste de travail. Après son installation, les utilisateurs listés pourront se connecter avec leurs comptes existants de Casa.

Pour l’ouvrir localement, servir le dossier avec un serveur HTTP (par exemple `python -m http.server 8000`) puis visiter `http://localhost:8000`. Le service worker et l’installation PWA nécessitent HTTPS ou `localhost`.
